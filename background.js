/**
 * background.js — 인스타 댓글 스카우트 서비스 워커 (순수 로컬, 상태 단독 writer)
 *
 * ── 역할 ─────────────────────────────────────────────────────────────────────
 * 이 확장은 "정보성 도구"로, content script(워커)가 인스타 게시물 DOM을 자동
 * 스크롤해 댓글을 수집한다. background는 수집 로직을 갖지 않고, **잡 상태 레코드의
 * 유일한 writer**로서 content가 보내는 생명주기 메시지를 받아 chrome.storage.local
 * 키 `insta-comment.job`에 공통 봉투 형태로 기록만 한다.
 *
 * ── single-writer 패턴 ───────────────────────────────────────────────────────
 *  - 명령(job.start/progress/done/error/cancel) = chrome.runtime 메시지 (content → background)
 *  - 상태 레코드(insta-comment.job) = background만 갱신. content/popup은 읽기(get)만.
 *  - content는 절대 이 키에 직접 쓰지 않는다. (race 방지)
 *
 * ── 순수 로컬 ────────────────────────────────────────────────────────────────
 * 서버 통신/로그인 없음. fetch로 외부 서버를 호출하지 않는다.
 */

const STORAGE_KEY = 'insta-comment.job';
const TOOL_ID = 'insta-comment';
const SCHEMA = 'insta-comment-export.job/v1';

// status enum: pending | running | done | error | canceled
// (인스타 수집은 즉시 시작되므로 pending은 거의 쓰이지 않지만 enum은 표준대로 유지)

/** 현재 ISO8601 UTC(Z) 문자열. */
function nowIso() {
  return new Date().toISOString();
}

/** RFC4122 v4 UUID. crypto.randomUUID 가능하면 사용, 아니면 폴백. */
function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 상태 레코드 읽기 (단독 writer지만 read는 누구나 가능). */
function getRecord() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, data => resolve(data[STORAGE_KEY] || null));
  });
}

/** 상태 레코드 쓰기 (background만 호출). */
function setRecord(record) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEY]: record }, () => resolve());
  });
}

/**
 * 공통 봉투 레코드를 만든다/갱신한다. background만 호출.
 * @param {object} patch 덮어쓸 필드 (status, payload, progress, error 등)
 * @param {object|null} base 기존 레코드 (없으면 새로 생성)
 */
function buildRecord(patch, base) {
  const now = nowIso();
  if (!base) {
    return {
      schema: SCHEMA,
      toolId: TOOL_ID,
      jobId: patch.jobId || uuid(),
      createdAt: now,
      updatedAt: now,
      status: patch.status || 'pending',
      payload: patch.payload || {},
      progress: patch.progress || { done: 0, total: 0 },
      error: patch.error || null,
    };
  }
  return {
    ...base,
    // 불변 필드는 base 유지 (schema/toolId/jobId/createdAt)
    schema: SCHEMA,
    toolId: TOOL_ID,
    jobId: base.jobId,
    createdAt: base.createdAt,
    updatedAt: now,
    status: patch.status !== undefined ? patch.status : base.status,
    payload: patch.payload !== undefined ? patch.payload : base.payload,
    progress: patch.progress !== undefined ? patch.progress : base.progress,
    error: patch.error !== undefined ? patch.error : base.error,
  };
}

/**
 * 미완 잡 정리(reconciler): 이전 세션에서 running으로 남은 잡은
 * service worker가 죽으면(SW idle 후 종료) 이어갈 수 없으므로 canceled로 정리한다.
 * onInstalled(설치/업데이트)와 onStartup(브라우저 재시작·SW 재기동) 둘 다에서 호출한다.
 * MV3 SW는 수시로 종료/재기동되므로 onStartup에도 걸어야 stale running이 남지 않는다.
 */
function reconcile() {
  return getRecord().then(rec => {
    if (rec && rec.status === 'running') {
      return setRecord(buildRecord({
        status: 'canceled',
        error: { code: 'UNKNOWN', message: '확장 재시작으로 이전 추출이 중단되었습니다.' },
      }, rec));
    }
  });
}

// ── 설치/시작 시 초기화 ───────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => { reconcile(); });
chrome.runtime.onStartup.addListener(() => { reconcile(); });

// ── content(워커)로부터 잡 생명주기 메시지 수신 ───────────────────────────────
// content는 같은 잡에 대해 start → progress(여러 번) → done|error|canceled 순으로 보낸다.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: 'unknown message' });
    return false;
  }

  switch (msg.type) {
    // 추출 시작 — 새 잡 레코드 생성(새 jobId). payload에 옵션·원본URL 박제.
    case 'job.start': {
      const record = buildRecord({
        jobId: uuid(),
        status: 'running',
        payload: {
          options: msg.options || {},
          sourceUrl: msg.sourceUrl || '',
        },
        progress: { done: 0, total: msg.total || 0 },
        error: null,
      }, null);
      setRecord(record).then(() => sendResponse({ ok: true, jobId: record.jobId }));
      return true; // 비동기 응답
    }

    // 진행률 갱신 — 현재 레코드 위에 progress만 덮어쓴다(상태는 running 유지).
    case 'job.progress': {
      getRecord().then(base => {
        // 잡이 없거나 이미 종료된 잡엔 진행률을 쓰지 않는다(stale 메시지 방어).
        if (!base || base.status !== 'running') {
          sendResponse({ ok: false, error: 'no running job' });
          return;
        }
        const progress = {
          done: typeof msg.done === 'number' ? msg.done : (base.progress && base.progress.done) || 0,
          total: typeof msg.total === 'number' ? msg.total : (base.progress && base.progress.total) || 0,
        };
        setRecord(buildRecord({ status: 'running', progress }, base)).then(() => sendResponse({ ok: true }));
      });
      return true;
    }

    // 완료 — status=done, 최종 건수 반영.
    case 'job.done': {
      getRecord().then(base => {
        const total = typeof msg.total === 'number' ? msg.total : (base && base.progress && base.progress.total) || 0;
        setRecord(buildRecord({
          status: 'done',
          progress: { done: total, total },
          error: null,
        }, base)).then(() => sendResponse({ ok: true }));
      });
      return true;
    }

    // 중단(사용자가 "중지하고 지금까지 저장") — status=canceled, 그때까지 건수 보존.
    case 'job.canceled': {
      getRecord().then(base => {
        const done = typeof msg.done === 'number' ? msg.done : (base && base.progress && base.progress.done) || 0;
        const total = (base && base.progress && base.progress.total) || done;
        setRecord(buildRecord({
          status: 'canceled',
          progress: { done, total },
          error: null,
        }, base)).then(() => sendResponse({ ok: true }));
      });
      return true;
    }

    // 오류 — status=error, error 봉투 채움.
    case 'job.error': {
      getRecord().then(base => {
        setRecord(buildRecord({
          status: 'error',
          error: {
            code: msg.code || 'UNKNOWN',
            message: msg.message || '추출 중 오류가 발생했습니다.',
          },
        }, base)).then(() => sendResponse({ ok: true }));
      });
      return true;
    }

    // 현재 상태 레코드 조회 (popup/content 가 읽기용으로 사용).
    case 'job.get': {
      getRecord().then(rec => sendResponse({ ok: true, record: rec }));
      return true;
    }

    default:
      sendResponse({ ok: false, error: 'unknown message type: ' + msg.type });
      return false;
  }
});
