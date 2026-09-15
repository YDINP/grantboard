/**
 * 문자열 템플릿용 HTML 조립 헬퍼. Astro가 자동으로 해 주던 이스케이프를 여기서 손으로 한다.
 *
 * 규칙: 데이터에서 온 값(공고명·메모·담당자·URL…)은 **예외 없이** esc()를 거쳐 마크업에 넣는다.
 * 이제 데이터는 디스코드에서 누구나 넣을 수 있으므로, 이스케이프를 한 군데라도 빠뜨리면 그대로 XSS다.
 * 속성값은 항상 큰따옴표로 감싸고 esc()로 넣는다 — attr()/dataAttrs()가 그 형식을 강제한다.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 텍스트 노드·속성값 공용 이스케이프. 숫자·불리언은 문자열로 바꿔서 처리한다. */
export function esc(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/**
 * 속성 하나. 값이 null/undefined/false면 속성 자체를 생략하고, true면 불리언 속성으로 쓴다.
 * 결과는 항상 앞에 공백을 붙여 반환하므로 `<div${attr('id', x)}>`처럼 붙여 쓴다.
 */
export function attr(name: string, value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return ` ${name}`;
  return ` ${name}="${esc(value)}"`;
}

/** 속성 여러 개. filters.ts의 serializeAttrs() 결과처럼 Record<string, string>을 그대로 받는다. */
export function attrs(record: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(record)
    .map(([name, value]) => attr(name, value))
    .join('');
}

/** class 속성. Astro의 class:list처럼 falsy 항목·조건부 객체를 걸러 준다. */
export function cls(...items: (string | false | null | undefined | Record<string, boolean>)[]): string {
  const names: string[] = [];
  for (const item of items) {
    if (!item) continue;
    if (typeof item === 'string') names.push(item);
    else for (const [name, on] of Object.entries(item)) if (on) names.push(name);
  }
  return names.length ? ` class="${esc(names.join(' '))}"` : '';
}

/** 조건부 렌더. `when(cond, () => html)`. */
export function when(condition: unknown, render: () => string): string {
  return condition ? render() : '';
}

/** 배열 렌더 후 이어 붙이기. */
export function each<T>(items: readonly T[], render: (item: T, index: number) => string): string {
  return items.map(render).join('');
}

/**
 * 링크로 열어도 되는 URL인지. '#'(출처 미확보)은 format.ts의 isLinkable이 걸러 주지만,
 * 이제 URL도 사람이 디스코드에서 넣는 값이라 `javascript:` 같은 스킴은 여기서 한 번 더 막는다.
 * 통과하지 못하면 호출자는 링크 대신 일반 텍스트로 그린다.
 */
export function safeHref(url: string | undefined | null): string | null {
  if (!url || url === '#') return null;
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}
