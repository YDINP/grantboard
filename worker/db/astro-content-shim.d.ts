/**
 * src/lib/board.ts는 타입만 'astro:content'에서 가져온다(`import type { CollectionEntry }`).
 * Worker 번들에는 Astro 가상 모듈이 없으므로 그대로 두면 타입체크가 깨진다.
 *
 * 런타임 코드는 만들지 않고 타입만 채워 넣되, 컬렉션 data를 worker/db/types.ts에 연결한다.
 * 덕분에 board.ts의 Program/Application/Document가 repo.ts가 돌려주는 타입과
 * **같은 타입**이 된다 — 형태가 어긋나면 any로 뭉개지지 않고 컴파일 에러로 드러난다.
 *
 * import는 반드시 inline `import('./types.ts').X` 형태로 쓴다. 파일 상단에 `import`를 두면
 * 이 .d.ts가 모듈이 되어 `declare module`이 "존재하지 않는 모듈의 augmentation"으로 취급되고,
 * `declare module` 블록 안에 두면 타입이 조용히 any로 무너진다(둘 다 에러 없이 틀린다).
 *
 * zod 스키마(src/content.config.ts)가 바뀌면 worker/db/types.ts를 고치면 되고, 여기는 그대로 둔다.
 */
declare module 'astro:content' {
  interface CollectionDataMap {
    programs: import('./types.ts').Program;
    applications: import('./types.ts').Application;
    documents: import('./types.ts').Document;
  }

  export type CollectionKey = keyof CollectionDataMap;

  export type CollectionEntry<C extends CollectionKey> = {
    id: string;
    collection: C;
    data: CollectionDataMap[C];
  };
}
