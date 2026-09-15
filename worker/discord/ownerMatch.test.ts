import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchesOwner } from './ownerMatch.ts';

describe('matchesOwner', () => {
  test('완전히 같은 이름은 매칭된다', () => {
    assert.equal(matchesOwner('에이든', '에이든'), true);
  });

  test('공백/대소문자 차이는 무시한다', () => {
    assert.equal(matchesOwner('Aiden', ' aiden '), true);
  });

  test('디스코드 표시 이름이 owner를 포함하면 매칭된다', () => {
    assert.equal(matchesOwner('에이든', '에이든#팀장'), true);
  });

  test('전혀 다른 이름은 매칭되지 않는다', () => {
    assert.equal(matchesOwner('에이든', '브라운'), false);
  });

  test('빈 문자열은 매칭되지 않는다', () => {
    assert.equal(matchesOwner('', '에이든'), false);
    assert.equal(matchesOwner('에이든', ''), false);
  });
});
