import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCustomId, decodeCustomId } from './customId.ts';

describe('customId 인코딩/디코딩 왕복', () => {
  test('namespace/action/params가 그대로 복원된다', () => {
    const id = encodeCustomId('status', 'select-value', 'govtech-2026');
    const decoded = decodeCustomId(id);
    assert.deepEqual(decoded, { namespace: 'status', action: 'select-value', params: ['govtech-2026'] });
  });

  test('파라미터가 없어도 왕복된다', () => {
    const id = encodeCustomId('programs', 'add-submit');
    const decoded = decodeCustomId(id);
    assert.deepEqual(decoded, { namespace: 'programs', action: 'add-submit', params: [] });
  });

  test('빈 문자열 파라미터(필터 미지정)도 그대로 보존된다', () => {
    const id = encodeCustomId('programs', 'list-page', '0', '', '');
    const decoded = decodeCustomId(id);
    assert.deepEqual(decoded, { namespace: 'programs', action: 'list-page', params: ['0', '', ''] });
  });

  test('콜론이 섞인 값도 안전하게 보존된다 (구분자가 콜론이 아니므로)', () => {
    const id = encodeCustomId('status', 'select-value', 'a:b:c');
    const decoded = decodeCustomId(id);
    assert.deepEqual(decoded.params, ['a:b:c']);
  });

  test('여러 파라미터를 담은 페이지네이션 custom_id가 100바이트 이내로 왕복된다', () => {
    const id = encodeCustomId('programs', 'list-page', '3', '정부지원사업', 'urgent');
    assert.ok(new TextEncoder().encode(id).length <= 100);
    const decoded = decodeCustomId(id);
    assert.deepEqual(decoded.params, ['3', '정부지원사업', 'urgent']);
  });

  test('100바이트를 넘는 custom_id는 조립 시점에 예외를 던진다', () => {
    const longId = 'x'.repeat(120);
    assert.throws(() => encodeCustomId('programs', 'list-page', longId));
  });
});
