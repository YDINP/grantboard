/**
 * /내마감 커맨드에서 "호출자가 담당인 것만" 골라내기 위한 이름 매칭.
 *
 * ⚠️ 알려진 한계: 이 프로젝트 데이터 모델에는 디스코드 유저ID ↔ applications.owner(이니셜/닉네임,
 * 최대 4자)를 잇는 매핑 테이블이 없다(팀리드 지시에도 명시되지 않음). 정확한 매핑이 생기기 전까지는
 * "디스코드 표시 이름과 owner 문자열이 서로를 포함하는가"로 근사 매칭한다. 오탐/누락 가능성이
 * 있으므로, 정확한 매핑이 필요해지면 별도 설정(예: KV/D1에 discordUserId→owner 테이블)을 추가하고
 * 이 함수를 교체해야 한다.
 */

function normalize(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

/** owner 문자열과 디스코드 표시 이름이 서로를 포함하면 같은 사람으로 본다(대소문자/공백 무시). */
export function matchesOwner(owner: string, displayName: string): boolean {
  const a = normalize(owner);
  const b = normalize(displayName);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}
