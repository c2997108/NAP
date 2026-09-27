export function isMemoryAllocationError(error) {
  return error?.code === 'WASM_MEMORY' || /WebAssembly\.Memory\(\).*?(?:could not allocate|allocation failed)|(?:out of memory|Cannot enlarge memory arrays)/i.test(error?.message || String(error));
}

export function memoryError(error) {
  const failure = new Error('解析用メモリーを確保できませんでした。同時に処理するサンプル数を減らすか、入力を分けて実行してください。単一WASMの上限は2 GiBです。');
  failure.name = 'MemoryAllocationError'; failure.code = 'WASM_MEMORY'; failure.cause = error;
  return failure;
}
