/**
 * D1에서 세 컬렉션 + 팀 프로필을 읽어 board.ts의 buildBoard로 넘기는 공통 진입점.
 * 모든 핸들러가 이 함수 하나만 부르면 된다 — D1 조회 방식이나 뷰모델 조립 방식이 바뀌어도
 * 여기 한 곳만 고치면 되게 하기 위함이다.
 */

import { loadAll } from '../db/repo.ts';
import { buildBoard, type BoardModel } from '../../src/lib/board.ts';

export async function loadBoardModel(db: Env['DB'], today: Date = new Date()): Promise<BoardModel> {
  const { programs, applications, documents, profile } = await loadAll(db);
  return buildBoard({ programs, applications, documents, profile, today });
}
