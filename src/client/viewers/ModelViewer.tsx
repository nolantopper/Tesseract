import { useEffect, useRef, useState } from 'react';
import * as T from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import cadWorkerUrl from './cad.worker?worker&url';
import ModelWorker from './model.worker?worker&inline';
import type { Part } from './model.worker';
import type { ViewerProps } from '../../shared/types';
import { readBytes, cadDecoder, embeddedParserWorker } from '../backend';
import ViewCube, { updateViewCube } from './ViewCube';

export default function ModelViewer({ artifact, onSelect }: ViewerProps) {
  const mount = useRef<HTMLDivElement>(null);
  const cube = useRef<HTMLDivElement>(null);
  const snapView = useRef<((direction: T.Vector3) => void) | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [dimensions, setDimensions] = useState('');
  useEffect(() => {
    const host = mount.current!;
    const abort = new AbortController();
    let worker: Worker | undefined;
    let renderer: T.WebGLRenderer;
    try {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
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
    const render = () => {
      renderer.render(scene, camera);
      if (cube.current) updateViewCube(cube.current, camera);
    };
    orbit.addEventListener('change', render);
    const box = new T.Box3(),
      center = new T.Vector3();
    let radius = 1,
      highlight: T.BoxHelper | undefined;
    const meshes: (T.Mesh | T.Points)[] = [];
    let animation = 0;
    const stopAnimation = () => cancelAnimationFrame(animation);
    orbit.addEventListener('start', stopAnimation);
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
      stopAnimation();
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
    function snap(direction: T.Vector3) {
      stopAnimation();
      const offset = new T.Vector3().subVectors(camera.position, orbit.target);
      const start = new T.Spherical().setFromVector3(offset);
      const target = new T.Spherical().setFromVector3(direction).makeSafe();
      const azimuth = target.theta - start.theta;
      const sweep = Math.atan2(Math.sin(azimuth), Math.cos(azimuth));
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
      const began = performance.now();
      const pose = new T.Spherical();
      const frame = (now: number) => {
        const progress = motion ? Math.min((now - began) / motion, 1) : 1;
        const eased = progress * progress * (3 - 2 * progress);
        pose.set(
          start.radius,
          T.MathUtils.lerp(start.phi, target.phi, eased),
          start.theta + sweep * eased,
        );
        camera.position.copy(offset.setFromSpherical(pose)).add(orbit.target);
        if (!orbit.update()) render();
        if (progress < 1) animation = requestAnimationFrame(frame);
      };
      frame(began);
    }
    function choose(object: T.Object3D, point: T.Vector3) {
      if (highlight) {
        scene.remove(highlight);
        highlight.geometry.dispose();
        (highlight.material as T.Material).dispose();
      }
      highlight = new T.BoxHelper(object, 0x66a7e8);
      scene.add(highlight);
      render();
      onSelect({
        artifactId: artifact.id,
        path: artifact.path,
        revision: artifact.revision,
        kind: 'object',
        objectId: object.userData.viewerId,
        objectName: object.name || artifact.name,
        coordinates: point.toArray() as [number, number, number],
      });
    }
    const down = new T.Vector2();
    const pointerDown = (e: PointerEvent) => down.set(e.clientX, e.clientY);
    const pointerUp = (e: PointerEvent) => {
      if (down.distanceTo(new T.Vector2(e.clientX, e.clientY)) > 4 || e.button !== 0) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ray = new T.Raycaster();
      ray.params.Points.threshold = radius * 0.02;
      ray.setFromCamera(
        new T.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          (-(e.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      const hit = ray.intersectObjects(meshes, false)[0];
      if (hit) choose(hit.object, hit.point);
    };
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    snapView.current = snap;
    const addRoot = (object: T.Object3D) => {
      if (abort.signal.aborted) {
        dispose(object);
        return;
      }
      let vertices = 0;
      object.traverse((child) => {
        if (child instanceof T.Mesh || child instanceof T.Points) {
          vertices += child.geometry.getAttribute('position')?.count ?? 0;
          child.userData.viewerId = `object-${meshes.length}`;
          meshes.push(child);
          if (child instanceof T.Mesh)
            for (const m of Array.isArray(child.material) ? child.material : [child.material])
              m.side = T.DoubleSide;
        }
      });
      if (!meshes.length || vertices > 6_000_000) {
        dispose(object);
        throw new Error('Model is empty or exceeds the 6 million vertex limit.');
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
            (material as T.PointsMaterial).size = radius * 0.005;
      setDimensions(
        size
          .toArray()
          .map((v) => Number(v.toPrecision(4)))
          .join(' × ') + ' units',
      );
      scene.add(object);
      fit();
      setLoading(false);
    };
    const fail = (e: unknown) => {
      if (!abort.signal.aborted) {
        setError(e instanceof Error ? e.message : 'Cannot parse model.');
        setLoading(false);
      }
    };
    readBytes(artifact, undefined, false, abort.signal)
      .then(async (data) => {
        if (abort.signal.aborted) return;
        if (artifact.format.id === 'glb' || artifact.format.id === 'gltf') {
          const manager = new T.LoadingManager();
          manager.setURLModifier((url) => {
            if (!url.startsWith('blob:') && !url.startsWith('data:'))
              throw new Error('Embed textures and buffers in the model.');
            return url;
          });
          const gltf = await new GLTFLoader(manager).parseAsync(data, '');
          addRoot(gltf.scene);
        } else {
          const usesDecoder = ['step', 'iges', 'laz'].includes(artifact.format.id);
          const wasm = usesDecoder
            ? await cadDecoder(abort.signal, artifact.format.id === 'laz' ? 'laz' : 'cad')
            : undefined;
          if (abort.signal.aborted) return;
          worker = usesDecoder
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
          worker.onmessage = (event: MessageEvent<{ parts?: Part[]; error?: string }>) => {
            clearTimeout(timer);
            worker?.terminate();
            if (abort.signal.aborted) return;
            if (event.data.error) return fail(new Error(event.data.error));
            try {
              const group = new T.Group();
              for (const part of event.data.parts ?? []) {
                const geometry = new T.BufferGeometry();
                for (const [key, attr] of Object.entries(part.attributes))
                  geometry.setAttribute(key, new T.BufferAttribute(attr.array, attr.itemSize));
                if (part.index) geometry.setIndex(new T.BufferAttribute(part.index, 1));
                const object = part.points
                  ? new T.Points(
                      geometry,
                      new T.PointsMaterial({
                        size: 0.025,
                        sizeAttenuation: true,
                        color: 0x91b7d4,
                        vertexColors: !!part.attributes.color,
                      }),
                    )
                  : new T.Mesh(
                      geometry,
                      new T.MeshStandardMaterial({
                        color: part.attributes.color ? 0xffffff : 0x94a8bb,
                        metalness: 0.12,
                        roughness: 0.48,
                        vertexColors: !!part.attributes.color,
                      }),
                    );
                object.name = part.name;
                group.add(object);
              }
              addRoot(group);
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
            { data, format: artifact.format.id, wasm },
            wasm ? [data, wasm] : [data],
          );
          abort.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        }
      })
      .catch(fail);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Home') {
        e.preventDefault();
        fit();
      }
    };
    host.addEventListener('keydown', key);
    resize();
    return () => {
      stopAnimation();
      abort.abort();
      worker?.terminate();
      observer.disconnect();
      orbit.dispose();
      snapView.current = undefined;
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      host.removeEventListener('keydown', key);
      dispose(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [artifact, onSelect]);
  return (
    <div className="model-view">
      <div className="preview-stage model-stage">
        <div className="model-canvas" ref={mount} />
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
        <div className="model-nav" hidden={loading || !!error}>
          <ViewCube cubeRef={cube} onSnap={(direction) => snapView.current?.(direction)} />
        </div>
      </div>
      {!loading && !error && <span className="dimensions">{dimensions}</span>}
    </div>
  );
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
