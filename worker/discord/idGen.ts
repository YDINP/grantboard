/**
 * 모달로 새 레코드(공고/서류)를 만들 때 쓰는 id 생성기.
 * 사람이 알아볼 수 있는 slug + 생성 시각(base36)으로 충돌 없는 id를 만든다.
 */

function slugify(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'item';
}

export function generateId(title: string): string {
  return `${slugify(title)}-${Date.now().toString(36)}`;
}
