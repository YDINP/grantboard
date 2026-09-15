/**
 * 디스코드 인터랙션 API의 최소 타입 정의.
 * discord-api-types 같은 외부 패키지를 새로 추가하지 않기 위해, 이 프로젝트가 실제로 쓰는
 * 필드만 담은 얇은 타입을 직접 선언한다. 전체 스펙은 필요 없다.
 * 참고: https://discord.com/developers/docs/interactions/receiving-and-responding
 */

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
} as const;

export const ButtonStyle = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
} as const;

export const TextInputStyle = {
  SHORT: 1,
  PARAGRAPH: 2,
} as const;

/** 메시지 플래그. 우리가 쓰는 건 '본인에게만 보이는 응답' 하나뿐이다. */
export const MessageFlags = {
  EPHEMERAL: 1 << 6,
} as const;

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface DiscordMember {
  user?: DiscordUser;
  /** 서버 별명. 있으면 username보다 우선해서 표시/매칭에 쓴다. */
  nick?: string | null;
}

export interface DiscordCommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordCommandOption[];
}

export interface DiscordModalTextInput {
  type: number;
  custom_id: string;
  value?: string;
}

export interface DiscordModalActionRow {
  type: number;
  components: DiscordModalTextInput[];
}

export interface DiscordInteractionData {
  id?: string;
  /** APPLICATION_COMMAND: 최상위 커맨드 이름. */
  name?: string;
  /** MESSAGE_COMPONENT / MODAL_SUBMIT: 우리가 인코딩한 custom_id. */
  custom_id?: string;
  component_type?: number;
  /** STRING_SELECT에서 사용자가 고른 값들. */
  values?: string[];
  /** APPLICATION_COMMAND: 서브커맨드/옵션 트리. */
  options?: DiscordCommandOption[];
  /** MODAL_SUBMIT: 입력된 텍스트 필드들 (action row로 감싸져 있음). */
  components?: DiscordModalActionRow[];
}

export interface DiscordInteraction {
  type: number;
  id: string;
  /** 후속 응답(웹훅 편집)에 쓰는 인터랙션 토큰. 15분간 유효. */
  token: string;
  application_id: string;
  channel_id?: string;
  guild_id?: string;
  member?: DiscordMember;
  /** DM 등 길드 밖 컨텍스트에서만 채워짐. 길드 커맨드만 쓰므로 보통 member.user를 쓴다. */
  user?: DiscordUser;
  message?: { id: string };
  data?: DiscordInteractionData;
}

/** 인터랙션 호출자의 표시 이름. 서버 별명 > 글로벌 표시명 > username 순으로 고른다. */
export function callerDisplayName(interaction: DiscordInteraction): string {
  const member = interaction.member;
  if (member?.nick) return member.nick;
  const user = member?.user ?? interaction.user;
  return user?.global_name ?? user?.username ?? '알 수 없음';
}

/** 인터랙션 호출자의 디스코드 유저 ID. /나는 매핑 조회·등록에 쓴다. 길드 밖 컨텍스트가 아니라면 항상 있다. */
export function callerUserId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}
