declare module 'libarchive.js/src/webworker/wasm-gen/libarchive.js' {
  interface ArchiveModule {
    HEAPU8: Uint8Array;
    cwrap(
      name: string,
      returns: 'number',
      args: string[],
    ): (...args: (number | string | null)[]) => number;
    cwrap(name: string, returns: 'string', args: string[]): (...args: number[]) => string;
    _malloc(size: number): number;
    _free(pointer: number): void;
    _get_next_entry(archive: number): number;
    _archive_entry_filetype(entry: number): number;
    _archive_entry_is_encrypted(entry: number): number;
    _archive_entry_size(entry: number): number;
    _archive_read_data_skip(archive: number): number;
    _get_filedata(archive: number, size: number): number;
    _archive_close(archive: number): void;
  }
  export default function createArchive(options: {
    wasmBinary: ArrayBuffer;
  }): Promise<ArchiveModule>;
}

declare module 'seek-bzip' {
  const bzip: {
    decode(
      input: Uint8Array,
      output: { writeByte(byte: number): void },
      multistream: boolean,
    ): void;
  };
  export default bzip;
}
