/**
 * 디스코드 인터랙션 엔드포인트의 단일 진입점.
 * 서명 검증 → PING 처리 → 인터랙션 종류별 라우팅 순서로 처리한다.
 *
 * ⚠️ 디스코드는 최초 응답을 3초 안에 요구한다. D1 접근이 있는 경로는 각 핸들러가 자체적으로
 * DEFERRED_* 응답을 먼저 반환하고, ctx.waitUntil로 실제 처리와 웹훅 편집을 이어간다.
 */

import { verifyDiscordRequest } from './verify.ts';
import { pongResponse, errorMessageResponse, messageResponse } from './responses.ts';
import { InteractionType, ComponentType, ButtonStyle } from './types.ts';
import type { DiscordInteraction } from './types.ts';
import { COMMAND_NAMES, PROGRAM_SUBCOMMANDS, STATUS_SUBCOMMANDS, DOCUMENT_SUBCOMMANDS } from './commands.ts';
import { decodeCustomId } from './customId.ts';

import { handleUrgentCommand } from './handlers/urgent.ts';
import { handleDocumentListCommand } from './handlers/documents.ts';
import { handleDocumentAddOpen, handleDocumentAddSubmit } from './handlers/documentsAdd.ts';
import { handleDocumentCompleteCommand, handleDocumentToggleSelect } from './handlers/documentsComplete.ts';
import {
  handleDocumentLinkCommand,
  handleDocumentLinkSelectDoc,
  handleDocumentLinkSelectApp,
} from './handlers/documentsLink.ts';
import { handleMyDeadlinesCommand } from './handlers/myDeadlines.ts';
import { handleMeCommand } from './handlers/me.ts';
import { handleStatusBoardCommand } from './handlers/statusBoardCommand.ts';
import {
  handleProgramAddOpen,
  handleProgramAddSubmit,
  handleProgramListCommand,
  handleProgramListPage,
} from './handlers/programs.ts';
import {
  handleProgramDeleteCommand,
  handleProgramDeleteSelect,
  handleProgramDeleteConfirm,
  handleProgramDeleteCancel,
} from './handlers/programsDelete.ts';
import { handleStatusChangeCommand, handleStatusProgramSelect, handleStatusValueSelect } from './handlers/status.ts';

export async function handleInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const body = await request.text();

  const valid = await verifyDiscordRequest(body, signature, timestamp, env.DISCORD_PUBLIC_KEY);
  if (!valid) {
    return new Response('invalid request signature', { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body);
  } catch {
    return new Response('invalid json body', { status: 400 });
  }

  if (interaction.type === InteractionType.PING) {
    return pongResponse();
  }

  try {
    switch (interaction.type) {
      case InteractionType.APPLICATION_COMMAND:
        return routeApplicationCommand(interaction, request, env, ctx);
      case InteractionType.MESSAGE_COMPONENT:
        return routeMessageComponent(interaction, env, ctx);
      case InteractionType.MODAL_SUBMIT:
        return routeModalSubmit(interaction, env, ctx);
      default:
        return errorMessageResponse('지원하지 않는 인터랙션 종류입니다.');
    }
  } catch (err) {
    console.error('인터랙션 처리 중 예외', err instanceof Error ? err.message : String(err));
    return errorMessageResponse('요청을 처리하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

function routeApplicationCommand(interaction: DiscordInteraction, request: Request, env: Env, ctx: ExecutionContext): Response {
  const name = interaction.data?.name;
  switch (name) {
    case COMMAND_NAMES.URGENT:
      return handleUrgentCommand(interaction, env, ctx);
    case COMMAND_NAMES.MY_DEADLINES:
      return handleMyDeadlinesCommand(interaction, env, ctx);
    case COMMAND_NAMES.CALENDAR:
      return handleCalendarCommand(request);
    case COMMAND_NAMES.ME:
      return handleMeCommand(interaction, env, ctx);
    case COMMAND_NAMES.STATUS_BOARD:
      return handleStatusBoardCommand(interaction, env, ctx);
    case COMMAND_NAMES.PROGRAM: {
      const sub = interaction.data?.options?.[0]?.name;
      if (sub === PROGRAM_SUBCOMMANDS.ADD) return handleProgramAddOpen();
      if (sub === PROGRAM_SUBCOMMANDS.LIST) return handleProgramListCommand(interaction, env, ctx);
      if (sub === PROGRAM_SUBCOMMANDS.DELETE) return handleProgramDeleteCommand(interaction, env, ctx);
      return errorMessageResponse('알 수 없는 /공고 서브커맨드입니다.');
    }
    case COMMAND_NAMES.STATUS: {
      const sub = interaction.data?.options?.[0]?.name;
      if (sub === STATUS_SUBCOMMANDS.CHANGE) return handleStatusChangeCommand(interaction, env, ctx);
      return errorMessageResponse('알 수 없는 /상태 서브커맨드입니다.');
    }
    case COMMAND_NAMES.DOCUMENTS: {
      const sub = interaction.data?.options?.[0]?.name;
      if (sub === DOCUMENT_SUBCOMMANDS.LIST) return handleDocumentListCommand(interaction, env, ctx);
      if (sub === DOCUMENT_SUBCOMMANDS.ADD) return handleDocumentAddOpen();
      if (sub === DOCUMENT_SUBCOMMANDS.COMPLETE) return handleDocumentCompleteCommand(interaction, env, ctx);
      if (sub === DOCUMENT_SUBCOMMANDS.LINK) return handleDocumentLinkCommand(interaction, env, ctx);
      return errorMessageResponse('알 수 없는 /서류 서브커맨드입니다.');
    }
    default:
      return errorMessageResponse(`알 수 없는 커맨드입니다: ${name ?? '(이름 없음)'}`);
  }
}

function routeMessageComponent(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  if (decoded.namespace === 'programs') {
    if (decoded.action === 'list-page') return handleProgramListPage(interaction, env, ctx);
    if (decoded.action === 'delete-select-program') return handleProgramDeleteSelect(interaction, env, ctx);
    if (decoded.action === 'delete-confirm') return handleProgramDeleteConfirm(interaction, env, ctx);
    if (decoded.action === 'delete-cancel') return handleProgramDeleteCancel();
  }
  if (decoded.namespace === 'status') {
    if (decoded.action === 'select-program') return handleStatusProgramSelect(interaction);
    if (decoded.action === 'select-value') return handleStatusValueSelect(interaction, env, ctx);
  }
  if (decoded.namespace === 'documents') {
    if (decoded.action === 'toggle-select') return handleDocumentToggleSelect(interaction, env, ctx);
    if (decoded.action === 'link-select-doc') return handleDocumentLinkSelectDoc(interaction, env, ctx);
    if (decoded.action === 'link-select-app') return handleDocumentLinkSelectApp(interaction, env, ctx);
  }
  return errorMessageResponse('알 수 없는 컴포넌트 상호작용입니다.');
}

function routeModalSubmit(interaction: DiscordInteraction, env: Env, ctx: ExecutionContext): Response {
  const decoded = decodeCustomId(interaction.data?.custom_id ?? '');
  if (decoded.namespace === 'programs' && decoded.action === 'add-submit') {
    return handleProgramAddSubmit(interaction, env, ctx);
  }
  if (decoded.namespace === 'documents' && decoded.action === 'add-submit') {
    return handleDocumentAddSubmit(interaction, env, ctx);
  }
  return errorMessageResponse('알 수 없는 모달 제출입니다.');
}

/** /달력 — DB 접근 없이 즉시 링크 버튼을 반환한다. */
function handleCalendarCommand(request: Request): Response {
  const origin = new URL(request.url).origin;
  return messageResponse('아래 버튼으로 달력을 확인하세요.', {
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          { type: ComponentType.BUTTON, style: ButtonStyle.LINK, label: '📅 달력 열기', url: `${origin}/calendar` },
        ],
      },
    ],
  });
}
