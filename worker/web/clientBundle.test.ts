/**
 * clientBundle.generated.ts 최신성 검사.
 * 브라우저 필터 판정은 src/lib/filters.ts를 번들에 포함해 서버와 같은 코드를 쓴다. 그 보장이 성립하려면
 * 커밋된 번들이 "지금 소스로 다시 만든 것"과 같아야 한다 — filters.ts나 client/main.mts를 고치고
 * `node worker/web/buildClient.ts`를 잊으면 여기서 깨진다.
 *
 *   node --test worker/web/*.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleClient, GENERATED_PATH, readGeneratedFile, renderGeneratedFile } from './buildClient.ts';

test('clientBundle.generated.ts는 client/main.mts + src/lib/filters.ts에서 다시 만든 결과와 같다', async () => {
  const committed = readGeneratedFile();
  assert.ok(committed !== null, `${GENERATED_PATH} 가 없습니다. \`node worker/web/buildClient.ts\`로 생성하세요.`);

  const expected = renderGeneratedFile(await bundleClient());
  assert.equal(
    committed,
    expected,
    'clientBundle.generated.ts가 소스보다 오래됐습니다. `node worker/web/buildClient.ts`로 재생성한 뒤 커밋하세요.',
  );
});

test('번들에는 filters.ts의 판정 함수가 실제로 들어 있다 (사본이 아니라 import)', async () => {
  const code = await bundleClient();
  // 이름은 esbuild가 그대로 보존한다(minify 안 함). 이 이름들이 사라졌다면 main.mts가 더 이상 filters.ts를 쓰지 않는 것.
  for (const name of ['matchesFilter', 'readAttrs', 'parseFilterState', 'isFilterActive', 'countSelections']) {
    assert.match(code, new RegExp(`function ${name}\\(`), `${name}이 번들에 없습니다`);
  }
  assert.doesNotMatch(code, /<\/script|<!--/i);
});
