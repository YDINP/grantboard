/**
 * 슬래시 커맨드 정의를 한 곳에 모은다. scripts/register-commands.mjs가 이 배열을 그대로 읽어
 * 디스코드에 등록하고, interactions.ts가 이름으로 라우팅한다.
 *
 * ⚠️ CATEGORY_CHOICES / STATUS_CHOICES / DOCUMENT_KIND_CHOICES는 src/content.config.ts의 zod
 * enum과 값이 같아야 한다. content.config.ts는 'astro:content'를 런타임에 import하므로(타입
 * 전용이 아님) Worker 번들에서 그대로 import할 수 없다 — 그래서 목록을 여기 복제해 둔다.
 * content.config.ts의 enum이 바뀌면 이 파일도 같이 고쳐야 한다.
 *
 * ⚠️ 커맨드 이름 변경 이력: `/서류`는 원래 서브커맨드 없이 바로 조회하는 단일 커맨드였다.
 * 서브커맨드(추가/완료/연결)가 생기면서 디스코드 스펙상 "서브커맨드가 있는 커맨드는 반드시
 * 서브커맨드로 호출해야 한다"는 제약 때문에 기존 조회 동작은 `/서류 목록`으로 옮겼다 —
 * 맨 `/서류`만으로는 더 이상 응답하지 않는다.
 */

const ApplicationCommandType = {
  CHAT_INPUT: 1,
} as const;

const ApplicationCommandOptionType = {
  SUB_COMMAND: 1,
  STRING: 3,
} as const;

/** content.config.ts programs.category와 동일한 값이어야 한다. */
export const CATEGORY_CHOICES = ['정부지원사업', '공모전', '경진대회', '교육프로그램', '기타'] as const;

/** content.config.ts applications.status와 동일한 값이어야 한다. 순서 = 진행 단계 순서. */
export const STATUS_CHOICES = [
  '검토중',
  '준비',
  '작성중',
  '제출완료',
  '서류통과',
  '최종선정',
  '탈락',
  '미지원',
] as const;

/** content.config.ts documents.kind와 동일한 값이어야 한다. */
export const DOCUMENT_KIND_CHOICES = ['서식', '증빙', '기타'] as const;

/** deadlineState 값 기준 필터. board.ts의 DeadlineState와 동일해야 한다. */
const DEADLINE_STATE_CHOICES = [
  { name: '오늘/3일 이내 마감', value: 'urgent' },
  { name: '7일 이내 마감', value: 'soon' },
  { name: '접수중', value: 'open' },
  { name: '접수예정', value: 'upcoming' },
  { name: '마감됨', value: 'closed' },
] as const;

export const COMMAND_NAMES = {
  URGENT: '임박',
  PROGRAM: '공고',
  STATUS: '상태',
  DOCUMENTS: '서류',
  MY_DEADLINES: '내마감',
  CALENDAR: '달력',
  ME: '나는',
  STATUS_BOARD: '현황',
} as const;

export const PROGRAM_SUBCOMMANDS = { ADD: '추가', LIST: '목록', DELETE: '삭제' } as const;
export const STATUS_SUBCOMMANDS = { CHANGE: '변경' } as const;
export const DOCUMENT_SUBCOMMANDS = { LIST: '목록', ADD: '추가', COMPLETE: '완료', LINK: '연결' } as const;

/** /나는의 담당자 이니셜 옵션 이름. applications.owner와 같은 4자 제약을 스키마 단계에서도 건다. */
export const ME_OWNER_OPTION = '이니셜';
const OWNER_MAX_LENGTH = 4;

/**
 * 길드 슬래시 커맨드 정의 목록. PUT /applications/{app_id}/guilds/{guild_id}/commands에
 * 그대로 보낼 수 있는 형태다(이름 1~32자 소문자/한글, 설명 1~100자 제약을 만족한다).
 */
export const COMMAND_DEFINITIONS = [
  {
    name: COMMAND_NAMES.URGENT,
    type: ApplicationCommandType.CHAT_INPUT,
    description: '마감 임박순 현황 — 오늘/3일 이내 마감, 내부마감 초과 미제출, 발표일 경과 미확인',
  },
  {
    name: COMMAND_NAMES.PROGRAM,
    type: ApplicationCommandType.CHAT_INPUT,
    description: '공고 관리',
    options: [
      {
        type: ApplicationCommandOptionType.SUB_COMMAND,
        name: PROGRAM_SUBCOMMANDS.ADD,
        description: '공고를 모달 폼으로 추가합니다',
      },
      {
        type: ApplicationCommandOptionType.SUB_COMMAND,
        name: PROGRAM_SUBCOMMANDS.LIST,
        description: '등록된 공고 목록을 봅니다',
        options: [
          {
            type: ApplicationCommandOptionType.STRING,
            name: '카테고리',
            description: '카테고리로 필터링',
            required: false,
            choices: CATEGORY_CHOICES.map((c) => ({ name: c, value: c })),
          },
          {
            type: ApplicationCommandOptionType.STRING,
            name: '상태',
            description: '접수 상태로 필터링',
            required: false,
            choices: DEADLINE_STATE_CHOICES.map((c) => ({ name: c.name, value: c.value })),
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.SUB_COMMAND,
        name: PROGRAM_SUBCOMMANDS.DELETE,
        description: '잘못 등록한 공고를 삭제합니다 (되돌릴 수 없음, 확인 단계 있음)',
      },
    ],
  },
  {
    name: COMMAND_NAMES.STATUS,
    type: ApplicationCommandType.CHAT_INPUT,
    description: '지원 현황 상태 관리',
    options: [
      {
        type: ApplicationCommandOptionType.SUB_COMMAND,
        name: STATUS_SUBCOMMANDS.CHANGE,
        description: '공고를 선택해 지원 상태를 변경합니다',
      },
    ],
  },
  {
    name: COMMAND_NAMES.DOCUMENTS,
    type: ApplicationCommandType.CHAT_INPUT,
    description: '서류 관리',
    options: [
      {
        type: ApplicationCommandOptionType.SUB_COMMAND,
        name: DOCUMENT_SUBCOMMANDS.LIST,
        description: '서류 준비 현황과 만료 임박 서류를 봅니다',
      },
      {
        type: ApplicationCommandOptionType.SUB_COMMAND,
        name: DOCUMENT_SUBCOMMANDS.ADD,
        description: '서류를 모달 폼으로 등록합니다',
      },
      {
        type: ApplicationCommandOptionType.SUB_COMMAND,
        name: DOCUMENT_SUBCOMMANDS.COMPLETE,
        description: '서류를 선택해 준비 완료 여부를 전환합니다',
      },
      {
        type: ApplicationCommandOptionType.SUB_COMMAND,
        name: DOCUMENT_SUBCOMMANDS.LINK,
        description: '서류를 지원건에 연결/해제합니다 (재사용 추적)',
      },
    ],
  },
  {
    name: COMMAND_NAMES.MY_DEADLINES,
    type: ApplicationCommandType.CHAT_INPUT,
    description: '내가 담당인 지원건의 마감 현황만 봅니다',
  },
  {
    name: COMMAND_NAMES.CALENDAR,
    type: ApplicationCommandType.CHAT_INPUT,
    description: '달력 페이지 링크를 받습니다',
  },
  {
    name: COMMAND_NAMES.ME,
    type: ApplicationCommandType.CHAT_INPUT,
    description: '내 디스코드 계정을 담당자 이니셜에 등록합니다 (/내마감 정확도용)',
    options: [
      {
        type: ApplicationCommandOptionType.STRING,
        name: ME_OWNER_OPTION,
        description: `담당자 이니셜/닉네임 (최대 ${OWNER_MAX_LENGTH}자, 실명 금지)`,
        required: true,
        max_length: OWNER_MAX_LENGTH,
      },
    ],
  },
  {
    name: COMMAND_NAMES.STATUS_BOARD,
    type: ApplicationCommandType.CHAT_INPUT,
    description: '현황판을 지금 바로 갱신하고 위치를 알려줍니다 (평소엔 자동 갱신됩니다)',
  },
] as const;
