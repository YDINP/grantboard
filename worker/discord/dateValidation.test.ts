import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateDateStr } from './dateValidation.ts';

describe('validateDateStr', () => {
  test('올바른 날짜는 통과한다', () => {
    assert.equal(validateDateStr('2026-09-15').ok, true);
  });

  test('윤년 2/29는 통과한다', () => {
    assert.equal(validateDateStr('2028-02-29').ok, true);
  });

  test('평년 2/29는 거부되고 사유를 알려준다', () => {
    const result = validateDateStr('2026-02-29');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /2월은 28일까지/);
  });

  test('형식이 틀리면(슬래시) 거부된다', () => {
    const result = validateDateStr('2026/09/15');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /형식이 올바르지 않습니다/);
  });

  test('빈 문자열은 거부된다', () => {
    const result = validateDateStr('');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /빈 값/);
  });

  test('존재하지 않는 월(13월)은 거부된다', () => {
    assert.equal(validateDateStr('2026-13-01').ok, false);
  });

  test('4월 31일처럼 그 달에 없는 날짜는 거부된다', () => {
    const result = validateDateStr('2026-04-31');
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /4월은 30일까지/);
  });
});
