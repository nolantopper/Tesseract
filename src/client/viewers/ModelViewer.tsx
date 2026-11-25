import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as T from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import cadWorkerUrl from './cad.worker?worker&url';
import advancedWorkerUrl from './advanced.worker?worker&url';
import ModelWorker from './model.worker?worker&inline';
import {
  cadSurfaces,
  objectFromParts,
  partsFromObject,
  disposeModel,
  type Part,
} from './model-parts';
import { parseMeshAsset } from './mesh-assets';
import { parsePrintModel } from './print-model';
import { joinAssetReference } from '../../shared/asset-path';
import type { ViewerProps } from '../../shared/types';
import { maxModelParts, selectionKey, type SelectedPart } from '../../shared/view';
import {
  readBytes,
  cadDecoder,
  embeddedParserWorker,
  canDownloadArtifact,
  canSaveHostFile,
  downloadArtifact,
  saveHostFile,
  readAsset as readWorkspaceAsset,
} from '../backend';
import { repaintGlb, repaintGltf, type GlbPaint } from './glb-edits';
import { isRotatableMesh, rotateMeshSource, type RotationAxis } from './mesh-edits';
import type { StepFacePaint } from './step-edits';
import { Icon } from '../Icon';
import { buildPose, type Joint, type JointHandle } from './model-joints';
import { dragJoint } from './model-joint-drag';
import { faceNormal, faceOverlay, findFace, type FacePatch } from './model-faces';
import './model-edit.css';

type PaintablePart = Omit<GlbPaint, 'color'> & {
  mesh: T.Mesh;
  material: T.MeshStandardMaterial | T.MeshBasicMaterial;
};
type Drawable = T.Mesh | T.Points | T.LineSegments;
type Target = { object: Drawable; face?: FacePatch };
type Highlight = { target: Target; group: T.Group; update: () => void; dispose: () => void };
type ColorTarget = { objectId: string; faceIndex?: number; color: string };
const modelViews: Record<string, [number, number, number]> = {
  '0': [1, 1, 1],
  '1': [0, 0, 1],
  '2': [1, 0, 0],
  '3': [0, 0, -1],
  '4': [-1, 0, 0],
  '5': [0, 1, 0],
  '6': [0, -1, 0],
};
export default function ModelViewer({
  artifact,
  onSelect,
  onDeselect,
  onShareSelection,
  chatPartIds,
  onSaveCopy,
  onContext,
  command,
  onCommandResult,
  captureRef,
  resolvePartRef,
  clearSelectionRef,
  readAsset,
}: ViewerProps) {
  const mount = useRef<HTMLDivElement>(null);
  const announcement = useRef<HTMLDivElement>(null);
  const paint = useRef<
    | ((id: string, color: string, save?: boolean, signal?: AbortSignal) => Promise<string>)
    | undefined
  >(undefined);
  const paintFace = useRef<
    | ((id: string, index: number, color: string, signal?: AbortSignal) => Promise<string>)
    | undefined
  >(undefined);
  const rotateModel = useRef<
    ((axis: RotationAxis, signal?: AbortSignal) => Promise<string>) | undefined
  >(undefined);
  const changePose = useRef<((jointId?: string, value?: number) => string) | undefined>(undefined);
  const updateChatHighlight = useRef<((ids?: readonly string[]) => void) | undefined>(undefined);
  const handledCommand = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onSelect, onDeselect, onShareSelection, onSaveCopy, onContext });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [colorTarget, setColorTarget] = useState<ColorTarget>();
  const [showEditor, setShowEditor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');
  useLayoutEffect(() => {
    callbacks.current = { onSelect, onDeselect, onShareSelection, onSaveCopy, onContext };
  }, [onContext, onSelect, onDeselect, onShareSelection, onSaveCopy]);
  useEffect(() => {
    const host = mount.current!;
    const abort = new AbortController();
    const resources: (() => void)[] = [];
    const assets = new Map<string, Promise<ArrayBuffer>>();
    let assetBytes = artifact.size;
    const loadAsset = async (path: string) => {
      abort.signal.throwIfAborted();
      let pending = assets.get(path);
      if (!pending) {
        if (assets.size >= 64) throw new Error('Model exceeds the 64 linked asset limit.');
        pending = (
          readAsset
            ? readAsset(path, abort.signal)
            : readWorkspaceAsset(artifact, path, abort.signal)
        ).then((bytes) => {
          assetBytes += bytes.byteLength;
          if (assetBytes > 64 * 1024 * 1024)
            throw new Error('Model and linked assets exceed 64 MiB.');
          return bytes;
        });
        assets.set(path, pending);
      }
      return (await pending).slice(0);
    };
    let worker: Worker | undefined;
    let renderer: T.WebGLRenderer;
    try {
      renderer = new T.WebGLRenderer({
        antialias: true,
        alpha: true,
        logarithmicDepthBuffer: true,
      });
    } catch {
      setError('WebGL is unavailable. Enable hardware acceleration to preview this model.');
      setLoading(false);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);
    renderer.domElement.setAttribute('aria-label', '3D model viewport');
    renderer.domElement.setAttribute('tabindex', '0');
    const scene = new T.Scene();
    scene.add(new T.HemisphereLight(0xffffff, 0x667080, 2.7));
    const light = new T.DirectionalLight(0xffffff, 3);
    light.position.set(3, 6, 4);
    scene.add(light);
    const camera = new T.PerspectiveCamera(40, 1, 0.01, 100000);
    camera.position.set(1, 0.7, 1);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = false;
    const render = () => renderer.render(scene, camera);
    orbit.addEventListener('change', render);
    const box = new T.Box3(),
      center = new T.Vector3();
    let radius = 1;
    const meshes: Drawable[] = [];
    const surfaces: T.Mesh[] = [];
    const unitBox = new T.BoxGeometry(1, 1, 1);
    const edges = new T.EdgesGeometry(unitBox);
    const outline = new LineSegmentsGeometry().fromEdgesGeometry(edges);
    unitBox.dispose();
    edges.dispose();
    const selectionOutline = new LineMaterial({
      linewidth: 2,
      toneMapped: false,
      transparent: true,
      depthWrite: false,
      alphaToCoverage: true,
    });
    selectionOutline.onBeforeCompile = (shader) => {
      // Keep the full stroke above coplanar faces while retaining hidden-edge occlusion.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <logdepthbuf_fragment>',
        `#include <logdepthbuf_fragment>
        #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
          gl_FragDepth = max(0.0, gl_FragDepth - 0.0002);
        #endif`,
      );
    };
    const contextFill = new T.MeshBasicMaterial({
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: T.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const contextHighlights = new Map<string, Highlight>();
    const selected = new Map<
      string,
      { part: SelectedPart; target: Target; highlight: Highlight }
    >();
    let pose: ReturnType<typeof buildPose> | undefined;
    let poseRoot: T.Object3D;
    let followed = new Set<string>();
    function drawHighlights() {
      for (const [id, highlight] of contextHighlights) {
        if (!followed.has(id)) {
          highlight.dispose();
          contextHighlights.delete(id);
        }
      }
      for (const id of followed) {
        if (contextHighlights.has(id)) continue;
        const target = targetById(id);
        if (target) contextHighlights.set(id, highlightTarget(target, true));
      }
      for (const [id, { highlight }] of selected) {
        highlight.group.visible = !followed.has(id);
        highlight.update();
      }
      for (const highlight of contextHighlights.values()) highlight.update();
      const shared = [...contextHighlights.keys()];
      if (shared.length) renderer.domElement.dataset.chatParts = shared.join(' ');
      else renderer.domElement.removeAttribute('data-chat-parts');
      render();
    }
    updateChatHighlight.current = (ids) => {
      followed = new Set(ids);
      drawHighlights();
      publishContext();
    };
    const applyAccent = () => {
      const style = getComputedStyle(host);
      selectionOutline.color.setStyle(style.getPropertyValue('--accent').trim() || style.color);
      contextFill.color.copy(selectionOutline.color);
      for (const object of meshes)
        if (object instanceof T.Points)
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            if (material instanceof T.PointsMaterial) material.color.copy(selectionOutline.color);
      if (meshes.length) render();
    };
    const themeObserver = new MutationObserver(applyAccent);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
    colorScheme.addEventListener('change', applyAccent);
    applyAccent();
    const paintable = new Map<string, PaintablePart>();
    const colors = new Map<string, string>();
    const editStep =
      artifact.format.id === 'step' &&
      artifact.size <= 8 * 1024 * 1024 &&
      canSaveHostFile(artifact);
    let source: ArrayBuffer | undefined;
    const resize = () => {
      const width = Math.max(1, host.clientWidth),
        height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    function fit() {
      const direction = camera.position.clone().sub(orbit.target).normalize();
      const distance =
        radius / Math.sin(T.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, camera.aspect);
      camera.position.copy(center).addScaledVector(direction, distance * 1.2);
      camera.near = Math.max(radius / 10000, 0.00001);
      camera.far = Math.max(radius * 1000, 100);
      camera.updateProjectionMatrix();
      orbit.target.copy(center);
      if (!orbit.update()) render();
    }
    function removePart(id: string, highlight: Highlight) {
      highlight.dispose();
      selected.delete(id);
    }
    function clearSelection() {
      for (const [id, { highlight }] of selected) removePart(id, highlight);
    }
    function publishSelection() {
      drawHighlights();
      publishContext();
      const parts = [...selected.values()].map(({ part }) => resolvePart(part));
      const last = parts.at(-1);
      const target = selected.size === 1 ? selected.values().next().value?.target : undefined;
      let editable: ColorTarget | undefined;
      if (target && canSaveHostFile(artifact)) {
        const objectId: string = target.object.userData.viewerId;
        const material = paintable.get(objectId)?.mesh.material;
        if (
          !target.face &&
          (material instanceof T.MeshStandardMaterial || material instanceof T.MeshBasicMaterial)
        )
          editable = { objectId, color: '#' + material.color.getHexString() };
        if (editStep && target.face?.kind === 'surface' && target.object instanceof T.Mesh) {
          const index = target.face.triangles[0] * 3;
          const group = target.object.geometry.groups.find(
            ({ start, count }) => index >= start && index < start + count,
          );
          const materials = target.object.material;
          const surface = Array.isArray(materials)
            ? materials[group?.materialIndex ?? 0]
            : materials;
          if (surface instanceof T.MeshStandardMaterial)
            editable = {
              objectId,
              faceIndex: target.face.index,
              color: '#' + surface.color.getHexString(),
            };
        }
      }
      setColorTarget(editable);
      setShowEditor(false);
      setEditError('');
      if (!last) {
        renderer.domElement.removeAttribute('data-selected-part');
        callbacks.current.onDeselect?.(artifact);
        return;
      }
      renderer.domElement.dataset.selectedPart = selectionKey(last);
      callbacks.current.onSelect({
        ...last,
        artifactId: artifact.id,
        path: artifact.path,
        revision: artifact.revision,
        kind: 'object',
        parts,
      });
    }
    if (clearSelectionRef)
      clearSelectionRef.current = () => {
        lastTap = undefined;
        clearSelection();
        publishSelection();
      };
    function partName(object: T.Object3D) {
      const name: unknown = object.userData.name;
      return (
        (typeof name === 'string' ? name : object.name) ||
        object.parent?.name ||
        artifact.name
      ).slice(0, 200);
    }
    function targetById(id: string): Target | undefined {
      const local = selected.get(id)?.target;
      if (local) return local;
      const shared = contextHighlights.get(id)?.target;
      if (shared) return shared;
      const [objectId, kind, index] = id.split('/');
      const object = meshes[Number(objectId.slice(7))];
      if (!object || object.userData.viewerId !== objectId) return;
      if (!kind) return { object };
      if (
        !(object instanceof T.Mesh) ||
        (kind !== 'surface' && kind !== 'planar' && kind !== 'triangle')
      )
        return;
      const face = findFace(object, Number(index), kind);
      if (face?.kind === kind && face.index === Number(index)) return { object, face };
    }
    function resolvePart(part: SelectedPart): SelectedPart {
      if (!part.localCoordinates) return part;
      const object = meshes[Number(part.objectId.slice(7))];
      if (!object || object.userData.viewerId !== part.objectId) return part;
      const coordinates = object.localToWorld(new T.Vector3(...part.localCoordinates)).toArray();
      if (!part.face?.localNormal) return { ...part, coordinates };
      const normal = new T.Vector3(...part.face.localNormal)
        .applyNormalMatrix(new T.Matrix3().getNormalMatrix(object.matrixWorld))
        .toArray();
      return { ...part, coordinates, face: { ...part.face, normal } };
    }
    if (resolvePartRef) resolvePartRef.current = resolvePart;
    function highlightTarget({ object, face }: Target, shared: boolean): Highlight {
      const group = new T.Group();
      const patch = face && object instanceof T.Mesh ? faceOverlay(object, face) : undefined;
      const line =
        !patch || patch.lines.length
          ? new LineSegments2(
              patch ? new LineSegmentsGeometry().setPositions(patch.lines) : outline,
              selectionOutline,
            )
          : undefined;
      if (line) {
        line.renderOrder = 2;
        group.add(line);
      }
      const fill =
        patch && (shared || !patch.lines.length)
          ? new T.Mesh(
              new T.BufferGeometry().setAttribute(
                'position',
                new T.Float32BufferAttribute(patch.positions, 3),
              ),
              contextFill,
            )
          : shared && object instanceof T.Mesh
            ? object.clone(false)
            : undefined;
      if (fill) {
        fill.material = contextFill;
        fill.renderOrder = 1;
        fill.matrixAutoUpdate = false;
        group.add(fill);
      }
      group.matrixAutoUpdate = !patch;
      const bounds = new T.Box3();
      const update = () => {
        object.updateWorldMatrix(true, false);
        if (patch) {
          group.matrix.copy(object.matrixWorld);
          group.matrixWorldNeedsUpdate = true;
        } else {
          if (line) {
            bounds.setFromObject(object);
            bounds.getCenter(line.position);
            bounds.getSize(line.scale);
          }
          if (fill) {
            fill.matrix.copy(object.matrixWorld);
            fill.matrixWorldNeedsUpdate = true;
          }
        }
      };
      update();
      scene.add(group);
      return {
        target: { object, face },
        group,
        update,
        dispose() {
          scene.remove(group);
          if (patch) {
            line?.geometry.dispose();
            fill?.geometry.dispose();
          }
        },
      };
    }
    function choose(id: string, target: Target, point: T.Vector3, additive: boolean) {
      const { object, face } = target;
      if (!additive && selected.has(id)) return;
      if (!additive) clearSelection();
      const existing = selected.get(id);
      if (existing) removePart(id, existing.highlight);
      else if (selected.size < maxModelParts) {
        const highlight = highlightTarget(target, false);
        const localNormal =
          face && object instanceof T.Mesh ? faceNormal(object, face).toArray() : undefined;
        selected.set(id, {
          target,
          highlight,
          part: {
            objectId: object.userData.viewerId,
            objectName: partName(object),
            coordinates: point.toArray(),
            localCoordinates:
              face || pose ? object.worldToLocal(point.clone()).toArray() : undefined,
            face: face &&
              localNormal && {
                kind: face.kind,
                index: face.index,
                triangleCount: face.triangles.length,
                normal: localNormal,
                localNormal,
              },
          },
        });
      }
      publishSelection();
    }
    const down = new T.Vector2();
    const canvas = renderer.domElement;
    const clearPointerFocus = () => canvas.removeAttribute('data-pointer-focus');
    let activePointer: number | undefined;
    let gesture:
      { joint: JointHandle; moved: boolean; move: (position: T.Vector2) => number } | undefined;
    let activeJointId: string | undefined;
    let hoverFrame = 0;
    let lastTap: { id: string; type: string; time: number; position: T.Vector2 } | undefined;
    let lastFace: { object: T.Mesh; face: FacePatch } | undefined;
    const dragThreshold = (e: PointerEvent) => (e.pointerType === 'touch' ? 10 : 4);
    function pick(position: T.Vector2, rect: DOMRect, faces = false) {
      const ray = new T.Raycaster();
      ray.params.Points.threshold = radius * 0.02;
      ray.params.Line.threshold = Math.max(
        radius * 0.001,
        (6 *
          camera.position.distanceTo(orbit.target) *
          Math.tan(T.MathUtils.degToRad(camera.fov / 2))) /
          rect.height,
      );
      ray.setFromCamera(
        new T.Vector2(
          ((position.x - rect.left) / rect.width) * 2 - 1,
          (-(position.y - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      return ray.intersectObjects<Drawable>(faces ? surfaces : meshes, false)[0];
    }
    const pointerDown = (e: PointerEvent) => {
      canvas.setAttribute('data-pointer-focus', '');
      if (!e.isPrimary || e.button !== 0 || activePointer !== undefined) return;
      cancelAnimationFrame(hoverFrame);
      activePointer = e.pointerId;
      down.set(e.clientX, e.clientY);
      if (!pose || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const rect = canvas.getBoundingClientRect();
      const hit = pick(down, rect);
      const joint = hit && pose.jointAt(hit.object);
      if (!joint) return;
      orbit.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      activeJointId = joint.id;
      gesture = {
        joint,
        moved: false,
        move: dragJoint(joint, hit.point, down, rect, camera, radius),
      };
    };
    const pointerMove = (e: PointerEvent) => {
      if (gesture && e.pointerId === activePointer) {
        const position = new T.Vector2(e.clientX, e.clientY);
        if (!gesture.moved && down.distanceTo(position) <= dragThreshold(e)) return;
        gesture.moved = true;
        lastTap = undefined;
        canvas.style.cursor = 'grabbing';
        applyPose(gesture.joint.id, gesture.move(position));
      } else if (pose && !e.buttons && e.pointerType !== 'touch') {
        cancelAnimationFrame(hoverFrame);
        hoverFrame = requestAnimationFrame(() => {
          const hit =
            !e.altKey && pick(new T.Vector2(e.clientX, e.clientY), canvas.getBoundingClientRect());
          canvas.style.cursor = hit && pose?.jointAt(hit.object) ? 'grab' : '';
        });
      }
    };
    const pointerLeave = () => {
      cancelAnimationFrame(hoverFrame);
      if (!gesture) canvas.style.cursor = '';
    };
    function finishPointer() {
      const id = activePointer;
      activePointer = undefined;
      if (!gesture) return;
      gesture = undefined;
      orbit.enabled = true;
      canvas.style.cursor = '';
      if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    }
    const pointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== activePointer) return;
      finishPointer();
      lastTap = undefined;
    };
    const pointerUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointer || e.button !== 0) return;
      const moved = gesture?.moved;
      finishPointer();
      const previous = lastTap;
      lastTap = undefined;
      const position = new T.Vector2(e.clientX, e.clientY);
      const touch = e.pointerType === 'touch';
      if (moved || down.distanceTo(position) > dragThreshold(e)) return;
      const pickFace = e.altKey && surfaces.length > 0;
      const hit = pick(position, canvas.getBoundingClientRect(), pickFace);
      if (!hit) {
        if (!e.shiftKey && selected.size) {
          clearSelection();
          publishSelection();
        }
        return;
      }
      const object = hit.object;
      let face: FacePatch | undefined;
      if (pickFace) {
        if (!(object instanceof T.Mesh) || hit.faceIndex == null) return;
        face =
          lastFace?.object === object && lastFace.face.triangles.includes(hit.faceIndex)
            ? lastFace.face
            : findFace(object, hit.faceIndex);
        if (!face) return;
        lastFace = { object, face };
      }
      const id = selectionKey({ objectId: object.userData.viewerId, face });
      choose(id, { object, face }, hit.point, e.shiftKey);
      if (!e.shiftKey && callbacks.current.onShareSelection) {
        if (
          previous?.id === id &&
          previous.type === e.pointerType &&
          e.timeStamp - previous.time <= 400 &&
          previous.position.distanceTo(position) <= (touch ? 24 : 8)
        ) {
          callbacks.current.onShareSelection(id);
        } else {
          lastTap = { id, type: e.pointerType, time: e.timeStamp, position };
        }
      }
    };
    canvas.addEventListener('pointerdown', pointerDown, true);
    canvas.addEventListener('blur', clearPointerFocus);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerleave', pointerLeave);
    canvas.addEventListener('pointercancel', pointerCancel);
    canvas.addEventListener('lostpointercapture', pointerCancel);
    canvas.addEventListener('pointerup', pointerUp);
    function publishContext() {
      const visible = new Set(
        [...followed].flatMap((id) => {
          const target = targetById(id);
          return target ? [target.object] : [];
        }),
      );
      for (const {
        target: { object },
      } of selected.values()) {
        if (visible.size === maxModelParts) break;
        visible.add(object);
      }
      for (const object of meshes) {
        if (visible.size === maxModelParts) break;
        visible.add(object);
      }
      callbacks.current.onContext?.({
        kind: 'model',
        joints: pose?.read(),
        ...(rotateModel.current && { canRotate: true }),
        objects: [...visible].map((object) => {
          const id: string = object.userData.viewerId;
          const part = paintable.get(id);
          const editableSurfaces = editStep ? Reflect.get(object.userData, cadSurfaces)?.length : 0;
          return {
            id,
            name: partName(object),
            ...(editableSurfaces && { editableSurfaces }),
            ...(part && {
              color: colors.get(id) ?? '#' + part.material.color.getHexString(),
              textured: !!part.material.map && !colors.has(id),
            }),
          };
        }),
      });
    }
    function recordPart(mesh: T.Mesh, parser: GLTFParser) {
      const material = mesh.material;
      if (!(material instanceof T.MeshStandardMaterial || material instanceof T.MeshBasicMaterial))
        return;
      // Textured transparency and vertex alpha require preserving the original color source.
      if (
        (material.map && (material.transparent || material.alphaTest > 0)) ||
        (material.vertexColors && mesh.geometry.getAttribute('color')?.itemSize === 4)
      )
        return;
      const mapping = parser.associations.get(mesh) as
        { meshes?: number; primitives?: number } | undefined;
      if (mapping?.meshes === undefined || mapping.primitives === undefined) return;
      for (let parent: T.Object3D | null = mesh; parent; parent = parent.parent) {
        const node = parser.associations.get(parent)?.nodes;
        if (node === undefined) continue;
        if (parser.json.nodes[node]?.mesh === mapping.meshes)
          paintable.set(mesh.userData.viewerId, {
            node,
            primitive: mapping.primitives,
            mesh,
            material,
          });
        break;
      }
    }
    const addRoot = (object: T.Object3D, parser?: GLTFParser, authoredJoints?: Joint[]) => {
      if (abort.signal.aborted) {
        dispose(object);
        return;
      }
      let vertices = 0;
      object.traverse((child) => {
        if (
          child instanceof T.Mesh ||
          child instanceof T.Points ||
          child instanceof T.LineSegments
        ) {
          vertices += child.geometry.getAttribute('position')?.count ?? 0;
          child.userData.viewerId = `object-${meshes.length}`;
          meshes.push(child);
          if (child instanceof T.Mesh) {
            surfaces.push(child);
            for (const m of Array.isArray(child.material) ? child.material : [child.material])
              m.side = T.DoubleSide;
          }
          if (parser && child instanceof T.Mesh) recordPart(child, parser);
        }
      });
      if (!meshes.length || meshes.length > 2000 || vertices > 6_000_000) {
        dispose(object);
        throw new Error('Model is empty or exceeds the 2,000 part or 6 million vertex limit.');
      }
      if (authoredJoints?.length) {
        poseRoot = object;
        pose = buildPose(object, authoredJoints);
        changePose.current = (id, value) => {
          if (gesture) finishPointer();
          applyPose(id, value);
          return `Moved ${pose!.read().find((joint) => joint.id === id)!.name} · preview`;
        };
      }
      box.setFromObject(object);
      if (box.isEmpty() || !Number.isFinite(box.min.length() + box.max.length())) {
        dispose(object);
        throw new Error('Model contains invalid coordinates.');
      }
      box.getCenter(center);
      const size = box.getSize(new T.Vector3());
      radius = Math.max(size.length() / 2, 0.001);
      for (const object of meshes)
        if (object instanceof T.Points)
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            if (material instanceof T.PointsMaterial) {
              material.size = 3;
              material.sizeAttenuation = false;
              material.toneMapped = false;
              material.vertexColors = false;
              material.color.copy(selectionOutline.color);
              material.needsUpdate = true;
            }
      scene.add(object);
      const editSignal = (signal?: AbortSignal) =>
        signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
      if (editStep)
        paintFace.current = async (id, faceIndex, color, requestedSignal) => {
          const signal = editSignal(requestedSignal);
          const target = targetById(`${id}/surface/${faceIndex}`);
          if (!target?.face) throw new Error('The selected STEP face is unavailable.');
          const bytes = await editStepFile(
            artifact,
            {
              mesh: Number(id.slice(7)),
              face: faceIndex,
              color,
            },
            signal,
          );
          await saveHostFile(artifact, bytes, signal);
          return `Saved face ${faceIndex + 1} color.`;
        };
      const format = artifact.format.id;
      if (isRotatableMesh(format) && artifact.size <= 8 * 1024 * 1024 && canSaveHostFile(artifact))
        rotateModel.current = async (axis, requestedSignal) => {
          const signal = editSignal(requestedSignal);
          const bytes = await readBytes(artifact, undefined, false, signal);
          await saveHostFile(artifact, rotateMeshSource(bytes, format, axis), signal);
          return `Saved 90° rotation around ${axis.toUpperCase()}.`;
        };
      const description = ['Press 0 for perspective, 1 through 6 for axis views, or Home to fit.'];
      let shortcuts = '0 1 2 3 4 5 6 Home';
      if (surfaces.length) description.push('Hold Option or Alt to pick a face.');
      if (pose?.read().some(({ min, max }) => min < max)) {
        description.push(
          'Drag a movable link. Page Up and Page Down choose a joint, arrows move it, and R resets the pose.',
        );
        shortcuts += ' PageUp PageDown ArrowUp ArrowDown ArrowLeft ArrowRight R';
      }
      canvas.setAttribute('aria-keyshortcuts', shortcuts);
      canvas.setAttribute('aria-description', description.join(' '));
      fit();
      publishContext();
      if (captureRef) {
        captureRef.current = (objectIds = [...selected.keys()]) => {
          const original = renderer.domElement;
          if (renderer.getContext().isContextLost()) return;
          const highlights = objectIds.flatMap((id) => {
            const target = targetById(id);
            return target ? [highlightTarget(target, true)] : [];
          });
          for (const { highlight } of selected.values()) highlight.group.visible = false;
          for (const highlight of contextHighlights.values()) highlight.group.visible = false;
          try {
            renderer.render(scene, camera);
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, 480 / Math.max(original.width, original.height));
            canvas.width = Math.max(1, Math.round(original.width * scale));
            canvas.height = Math.max(1, Math.round(original.height * scale));
            const context = canvas.getContext('2d');
            if (!context) return;
            context.fillStyle = getComputedStyle(document.documentElement).backgroundColor;
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(original, 0, 0, canvas.width, canvas.height);
            const image = canvas.toDataURL('image/jpeg', 0.78);
            if (image.length < 200 * 1024) return image;
          } finally {
            for (const highlight of highlights) highlight.dispose();
            for (const highlight of contextHighlights.values()) highlight.group.visible = true;
            drawHighlights();
          }
        };
      }
      if (source) {
        const model = source;
        const encodeEdits = (changes: Map<string, string>) => {
          const edits: GlbPaint[] = [];
          for (const [id, color] of changes) {
            const { node, primitive } = paintable.get(id)!;
            edits.push({ node, primitive, color });
          }
          return (artifact.format.id === 'gltf' ? repaintGltf : repaintGlb)(model, edits);
        };
        const save = async () => {
          await downloadArtifact(
            artifact.name.replace(/\.glb$/i, '') + '-edited.glb',
            'model/gltf-binary',
            encodeEdits(colors),
          );
        };
        paint.current = async (id, color, persist, requestedSignal) => {
          const part = paintable.get(id);
          if (!part) throw new Error('This part does not support recoloring.');
          const next = color.toLowerCase();
          if (persist) {
            await saveHostFile(
              artifact,
              encodeEdits(new Map([[id, next]])),
              editSignal(requestedSignal),
            );
            return `Saved ${partName(part.mesh)} color.`;
          }
          if (colors.get(id) === next) return 'Part already has that color.';
          const { mesh, material } = part;
          if (mesh.material !== material) (mesh.material as T.Material).dispose();
          const replacement = material.clone();
          replacement.color.set(next);
          replacement.map = null;
          replacement.vertexColors = false;
          mesh.material = replacement;
          const firstEdit = colors.size === 0;
          colors.set(id, next);
          if (firstEdit && artifact.format.id === 'glb' && canDownloadArtifact())
            callbacks.current.onSaveCopy?.(save);
          publishContext();
          render();
          return `Changed ${partName(mesh)} to ${next} · preview`;
        };
      }
      setLoading(false);
    };
    function applyPose(id?: string, value?: number) {
      if (!pose) return;
      pose.change(id, value);
      box.setFromObject(poseRoot);
      box.getCenter(center);
      radius = Math.max(box.getSize(new T.Vector3()).length() / 2, 0.001);
      drawHighlights();
      publishContext();
    }
    const fail = (e: unknown) => {
      if (!abort.signal.aborted) {
        setError(e instanceof Error ? e.message : 'Cannot parse model.');
        setLoading(false);
      }
    };
    readBytes(artifact, undefined, false, abort.signal)
      .then(async (data) => {
        if (abort.signal.aborted) return;
        const { id: format } = artifact.format;
        if (format === '3mf' || format === 'amf') {
          const parsed = await parsePrintModel(format, data, abort.signal);
          resources.push(parsed.release);
          addRoot(parsed.object);
        } else if (['glb', 'gltf', 'dae'].includes(format)) {
          const parsed = await parseMeshAsset(format, data, loadAsset, abort.signal);
          if (abort.signal.aborted) {
            parsed.release();
            disposeModel(parsed.object);
            return;
          }
          resources.push(parsed.release);
          if (format === 'glb' || (format === 'gltf' && canSaveHostFile(artifact))) source = data;
          addRoot(parsed.object, source ? parsed.parser : undefined);
        } else {
          const decoder = ['step', 'iges', 'brep'].includes(format)
            ? 'cad'
            : format === '3dm'
              ? 'rhino'
              : ['laz', 'ifc'].includes(format)
                ? format
                : undefined;
          const wasm = decoder ? await cadDecoder(abort.signal, decoder) : undefined;
          if (abort.signal.aborted) return;
          const advanced = ['3dm', 'ifc', 'fbx', '3ds', 'dxf'].includes(format);
          worker = advanced
            ? await embeddedParserWorker(advancedWorkerUrl, abort.signal)
            : decoder
              ? await embeddedParserWorker(cadWorkerUrl, abort.signal)
              : new ModelWorker();
          if (abort.signal.aborted) {
            worker.terminate();
            return;
          }
          const timer = window.setTimeout(() => {
            worker?.terminate();
            fail(new Error('Model parsing exceeded 20 seconds.'));
          }, 20000);
          worker.onmessage = async (
            event: MessageEvent<{
              type?: string;
              requestId: number;
              path: string;
              data: ArrayBuffer;
              format: string;
              parts?: Part[];
              joints?: Joint[];
              error?: string;
            }>,
          ) => {
            if (event.data.type === 'asset' || event.data.type === 'mesh') {
              const { type, requestId, path } = event.data;
              try {
                if (type === 'asset') {
                  const data = await loadAsset(path);
                  if (!abort.signal.aborted) worker?.postMessage({ requestId, data }, [data]);
                } else {
                  const loadMeshAsset = (uri: string) => {
                    if (!path) return loadAsset(uri);
                    return loadAsset(joinAssetReference(path, uri));
                  };
                  const parsed = await parseMeshAsset(
                    event.data.format,
                    event.data.data,
                    loadMeshAsset,
                    abort.signal,
                  );
                  try {
                    const parts = partsFromObject(parsed.object);
                    if (!abort.signal.aborted) worker?.postMessage({ requestId, parts });
                  } finally {
                    parsed.release();
                    disposeModel(parsed.object);
                  }
                }
              } catch (error) {
                if (!abort.signal.aborted)
                  worker?.postMessage({
                    requestId,
                    error: error instanceof Error ? error.message : 'Couldn’t load model asset.',
                  });
              }
              return;
            }
            clearTimeout(timer);
            worker?.terminate();
            if (abort.signal.aborted) return;
            if (event.data.error) return fail(new Error(event.data.error));
            try {
              const group = objectFromParts(event.data.parts ?? []);
              addRoot(group, undefined, event.data.joints);
            } catch (e) {
              fail(e);
            }
          };
          worker.onerror = (event) => {
            clearTimeout(timer);
            worker?.terminate();
            fail(
              new Error(
                `Model parser failed. ${event.message || 'This host may not permit parsing workers.'}`,
              ),
            );
          };
          worker.postMessage(
            { data, format: artifact.format.id, name: artifact.name, wasm },
            wasm ? [data, wasm] : [data],
          );
          abort.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        }
      })
      .catch(fail);
    const key = (e: KeyboardEvent) => {
      if (!e.altKey && !e.metaKey && !e.ctrlKey && e.key !== 'Shift') clearPointerFocus();
      if (
        !gesture &&
        meshes.length &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        Object.hasOwn(modelViews, e.key)
      ) {
        e.preventDefault();
        const distance = camera.position.distanceTo(orbit.target);
        camera.position.fromArray(modelViews[e.key]).setLength(distance).add(orbit.target);
        if (!orbit.update()) render();
        return;
      }
      if (e.key === 'Home') {
        if (gesture) return;
        e.preventDefault();
        fit();
        return;
      }
      if (e.key === 'Escape') {
        if (gesture) {
          applyPose(gesture.joint.id, gesture.joint.value);
          finishPointer();
        } else if (selected.size) {
          lastTap = undefined;
          clearSelection();
          publishSelection();
        }
        return;
      }
      if (!pose || gesture || e.metaKey || e.ctrlKey || e.altKey) return;
      const joints = pose.read().filter(({ min, max }) => min < max);
      if (!joints.length) return;
      const index = joints.findIndex(({ id }) => id === activeJointId);
      let message: string;
      if (e.key === 'PageDown' || e.key === 'PageUp') {
        const offset = e.key === 'PageDown' ? 1 : -1;
        const joint =
          joints[
            (Math.max(index, e.key === 'PageUp' ? 0 : -1) + offset + joints.length) % joints.length
          ];
        activeJointId = joint.id;
        message = joint.name;
      } else if (e.key.toLowerCase() === 'r') {
        applyPose();
        message = 'Pose reset';
      } else if (e.key.startsWith('Arrow')) {
        const joint = joints[Math.max(0, index)];
        activeJointId = joint.id;
        const direction = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : -1;
        const step = joint.unit === 'rad' ? T.MathUtils.degToRad(5) : (joint.max - joint.min) / 100;
        const value = T.MathUtils.clamp(joint.value + direction * step, joint.min, joint.max);
        applyPose(joint.id, value);
        const display =
          joint.unit === 'rad'
            ? `${Number(T.MathUtils.radToDeg(value).toFixed(1))}°`
            : `${Number(value.toFixed(3))} m`;
        message = `${joint.name}, ${display}`;
      } else return;
      e.preventDefault();
      if (announcement.current) announcement.current.textContent = message;
    };
    host.addEventListener('keydown', key);
    resize();
    return () => {
      cancelAnimationFrame(hoverFrame);
      finishPointer();
      abort.abort();
      worker?.terminate();
      for (const release of resources) release();
      observer.disconnect();
      themeObserver.disconnect();
      colorScheme.removeEventListener('change', applyAccent);
      orbit.dispose();
      paint.current = undefined;
      paintFace.current = undefined;
      rotateModel.current = undefined;
      changePose.current = undefined;
      updateChatHighlight.current = undefined;
      if (colors.size) callbacks.current.onSaveCopy?.();
      if (captureRef) captureRef.current = null;
      if (resolvePartRef) resolvePartRef.current = null;
      if (clearSelectionRef) clearSelectionRef.current = null;
      callbacks.current.onContext?.(null);
      for (const id of colors.keys()) {
        const { mesh, material } = paintable.get(id)!;
        (mesh.material as T.Material).dispose();
        mesh.material = material;
      }
      clearSelection();
      for (const highlight of contextHighlights.values()) highlight.dispose();
      contextFill.dispose();
      outline.dispose();
      selectionOutline.dispose();
      canvas.removeEventListener('pointerdown', pointerDown, true);
      canvas.removeEventListener('blur', clearPointerFocus);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerleave', pointerLeave);
      canvas.removeEventListener('pointercancel', pointerCancel);
      canvas.removeEventListener('lostpointercapture', pointerCancel);
      canvas.removeEventListener('pointerup', pointerUp);
      host.removeEventListener('keydown', key);
      dispose(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [artifact, captureRef, clearSelectionRef, readAsset, resolvePartRef]);
  useEffect(() => {
    updateChatHighlight.current?.(chatPartIds);
  }, [artifact, chatPartIds]);
  useEffect(() => {
    if (!command || loading || handledCommand.current === command.id) return;
    const { id, action } = command;
    handledCommand.current = id;
    void (async () => {
      try {
        let message;
        if (action.kind === 'set_joint' && changePose.current)
          message = changePose.current(action.jointId, action.value);
        else if (action.kind === 'set_color' && paint.current)
          message = await paint.current(
            action.objectId,
            action.color,
            command.save,
            command.signal,
          );
        else if (command.save && action.kind === 'set_face_color' && paintFace.current)
          message = await paintFace.current(
            action.objectId,
            action.faceIndex,
            action.color,
            command.signal,
          );
        else if (command.save && action.kind === 'rotate_model' && rotateModel.current)
          message = await rotateModel.current(action.axis, command.signal);
        else throw new Error('This model does not support that action.');
        onCommandResult?.(id, message);
      } catch (e) {
        onCommandResult?.(id, e instanceof Error ? e.message : 'Could not change the model.', true);
      }
    })();
  }, [command, loading, onCommandResult]);
  async function saveEdit(edit: () => Promise<string> | undefined) {
    if (saving) return;
    setSaving(true);
    setEditError('');
    try {
      const pending = edit();
      if (!pending) throw new Error('This edit is no longer available.');
      await pending;
      setShowEditor(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Could not save the model.');
    } finally {
      setSaving(false);
    }
  }

  const editorLabel = colorTarget ? 'Edit color' : 'Edit model';
  return (
    <div className="model-view" aria-busy={loading}>
      <div className="model-canvas" ref={mount} hidden={!!error} />
      <div className="model-announcement" ref={announcement} role="status" />
      {(colorTarget || rotateModel.current) && !loading && !error && (
        <div className="model-color-editor">
          <button
            type="button"
            className="icon-button"
            aria-label={editorLabel}
            title={editorLabel}
            aria-expanded={showEditor}
            onClick={() => setShowEditor(!showEditor)}
          >
            <Icon name="edit" />
          </button>
          {showEditor && colorTarget && (
            <>
              <input
                type="color"
                aria-label={colorTarget.faceIndex === undefined ? 'Part color' : 'Face color'}
                value={colorTarget.color}
                disabled={saving}
                onChange={(event) =>
                  setColorTarget({ ...colorTarget, color: event.currentTarget.value })
                }
              />
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  const { objectId, faceIndex, color } = colorTarget;
                  void saveEdit(() =>
                    faceIndex === undefined
                      ? paint.current?.(objectId, color, true)
                      : paintFace.current?.(objectId, faceIndex, color),
                  );
                }}
              >
                Save
              </button>
            </>
          )}
          {showEditor && rotateModel.current && (
            <button
              type="button"
              disabled={saving}
              title="Rotate 90° around Y and save"
              onClick={() => void saveEdit(() => rotateModel.current?.('y'))}
            >
              Rotate 90°
            </button>
          )}
          {editError && <span role="alert">{editError}</span>}
        </div>
      )}
      {loading && (
        <div className="overlay" role="status">
          Loading model…
        </div>
      )}
      {error && (
        <div className="overlay" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

async function editStepFile(
  artifact: ViewerProps['artifact'],
  stepPaint: StepFacePaint,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const [data, wasm] = await Promise.all([
    readBytes(artifact, 8 * 1024 * 1024, false, signal),
    cadDecoder(signal, 'cad'),
  ]);
  const worker = await embeddedParserWorker(cadWorkerUrl, signal);
  try {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const request = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const abort = () => reject(request.reason);
      if (request.aborted) return abort();
      request.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => {
        request.removeEventListener('abort', abort);
        if (data.bytes instanceof ArrayBuffer) resolve(data.bytes);
        else reject(new Error(data.error || 'Could not write STEP face color.'));
      };
      worker.onerror = () => {
        request.removeEventListener('abort', abort);
        reject(new Error('STEP face editing worker failed.'));
      };
      worker.postMessage({ data, wasm, format: 'step', stepPaint }, [data, wasm]);
    });
  } finally {
    worker.terminate();
  }
}
function dispose(root: T.Object3D) {
  root.traverse((object) => {
    const drawable = object as T.Mesh;
    drawable.geometry?.dispose();
    if (drawable.material)
      for (const material of Array.isArray(drawable.material)
        ? drawable.material
        : [drawable.material]) {
        for (const value of Object.values(material))
          if (value instanceof T.Texture) {
            if (value.image instanceof ImageBitmap) value.image.close();
            value.dispose();
          }
        material.dispose();
      }
  });
}
