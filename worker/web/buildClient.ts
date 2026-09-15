/**
 * 브라우저 스크립트 번들러. `client/main.mts`(+ 그것이 import하는 src/lib/filters.ts)를 esbuild로
 * IIFE 한 덩어리로 묶어 `clientBundle.generated.ts`에 문자열 상수로 써 넣는다.
 *
 *   node worker/web/buildClient.ts          # 재생성
 *   node --test worker/web/*.test.ts        # 생성물이 최신인지 검사 (clientBundle.test.ts)
 *
 * 생성물은 커밋한다 — Worker 배포(wrangler deploy)가 이 스크립트를 돌려 준다고 전제하지 않는다.
 * 대신 clientBundle.test.ts가 "지금 소스로 다시 만들면 커밋된 것과 같은가"를 검사하므로,
 * filters.ts나 main.mts를 고치고 재생성을 잊으면 테스트가 깨진다.
 *
 * 출력은 결정적이다(타임스탬프·해시 없음). 같은 소스 + 같은 esbuild 버전이면 바이트까지 같다.
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// new URL(...)을 쓰지 않는다 — worker tsconfig에서는 전역 URL이 workers-types 것이라 node:url 시그니처와 어긋난다.
const HERE = dirname(fileURLToPath(import.meta.url));
export const CLIENT_ENTRY = resolve(HERE, 'client/main.mts');
export const GENERATED_PATH = resolve(HERE, 'clientBundle.generated.ts');

/** 브라우저 번들 문자열을 만든다. 파일을 쓰지는 않는다. */
export async function bundleClient(): Promise<string> {
  const result = await build({
    entryPoints: [CLIENT_ENTRY],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    // 2019: 옵셔널 체이닝·널 병합을 풀어 준다. 팀원 폰 브라우저가 몇 년 묵었어도 필터가 조용히 죽지 않게.
    target: ['es2019'],
    charset: 'utf8',
    legalComments: 'none',
    minify: false,
    treeShaking: true,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]!.text;

  // 인라인 <script> 안에 들어가므로 HTML 파서가 스크립트를 끊는 시퀀스가 있으면 안 된다.
  // 데이터는 번들에 섞이지 않으니 원래 없어야 하고, 있다면 소스가 잘못된 것이라 빌드를 멈춘다.
  if (/<\/script|<!--/i.test(code)) {
    throw new Error('client bundle contains "</script" or "<!--" — inline <script>를 깨뜨린다');
  }
  return code;
}

/** 생성 파일 전체 내용. 테스트가 같은 함수로 기대값을 만든다. */
export function renderGeneratedFile(code: string): string {
  return [
    '/* eslint-disable */',
    '// 자동 생성 파일 — 직접 수정하지 말 것. `node worker/web/buildClient.ts`로 재생성한다.',
    '// 입력: worker/web/client/main.mts 와 그것이 import하는 src/lib/filters.ts. 최신성 검사: clientBundle.test.ts',
    `export const CLIENT_BUNDLE = ${JSON.stringify(code)};`,
    '',
  ].join('\n');
}

export function readGeneratedFile(): string | null {
  try {
    return readFileSync(GENERATED_PATH, 'utf8');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const code = await bundleClient();
  const content = renderGeneratedFile(code);
  const changed = readGeneratedFile() !== content;
  writeFileSync(GENERATED_PATH, content, 'utf8');
  console.log(`${changed ? 'updated' : 'unchanged'} ${GENERATED_PATH} (bundle ${code.length.toLocaleString()} chars)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
