/**
 * content.js — 인스타 댓글 스카우트 (엔진 + Shadow DOM UI)
 *
 * 한 파일에 ① UI 주입(Shadow DOM 격리) ② 수집 엔진(자동스크롤+관찰) ③ 엑셀 출력
 * ④ background와의 single-writer 통신을 담는다. "유저 세션 DOM 자동 스크롤 +
 * role 기반 셀렉터" 접근법으로 작성했다.
 *
 * ── single-writer 패턴 ───────────────────────────────────────────────────────
 * content는 워커다. 상태 레코드(chrome.storage `insta-comment.job`)에 **직접 쓰지
 * 않는다**. 잡 생명주기를 chrome.runtime.sendMessage(job.start/progress/done/
 * canceled/error)로 background에 보고하고, background가 단독으로 storage를 갱신한다.
 * UI 진행률은 같은 content 컨텍스트라 DOM을 직접 갱신한다(메시지는 상태 기록용).
 *
 * ── 순수 로컬 (대전제) ───────────────────────────────────────────────────────
 * 서버 통신/로그인/킬스위치 없음. 엑셀은 클라이언트에서 SheetJS로 생성 후 다운로드.
 *
 * ⚠️ 셀렉터 튜닝 지점: 인스타는 클래스명을 난독화/수시 변경하므로 아래 SELECTORS와
 *    COLLECT 휴리스틱은 role/구조/`time[datetime]` 기반 + 폴백으로 짰다. 실제 인스타
 *    로그인 세션에서 깨질 수 있는 지점은 각 함수 주석의 [튜닝] 표시 참고.
 */

(() => {
  'use strict';

  // 중복 주입 방지 (SPA 재실행/중복 inject 대비)
  if (window.__instaCommentExportLoaded) return;
  window.__instaCommentExportLoaded = true;

  const TOOL_VERSION = '0.1.0';

  // ────────────────────────────────────────────────────────────────────────────
  // 0. 폰트 주입 (document.head — 폰트는 document-scope라 shadow 내부에도 적용됨)
  // ────────────────────────────────────────────────────────────────────────────
  function injectFonts() {
    const links = [
      'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css',
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700&display=swap',
    ];
    for (const href of links) {
      if (document.head.querySelector(`link[href="${href}"]`)) continue;
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      document.head.appendChild(l);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 1. Shadow DOM UI — design-preview.html의 토큰/컴포넌트를 그대로 이식
  // ────────────────────────────────────────────────────────────────────────────
  const STYLE = `
:host{ all:initial; }
*{box-sizing:border-box;margin:0;padding:0}
.root{
  --font-ui:'Pretendard Variable',Pretendard,-apple-system,system-ui,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,monospace;
  --r-sm:6px; --r-md:10px; --r-lg:14px; --r-full:999px;
  --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:20px; --sp-6:24px;
  --success:#1F7A4D; --warning:#F59E0B; --danger:#EF4444;
  --ease-out:cubic-bezier(.16,1,.3,1);
  --accent:#1B3A6B; --accent-ink:#FFFFFF; --accent-soft:#EEF2F8;
  /* LIGHT / PAPER (브랜드 기본) */
  --surface:#FFFFFF; --surface-2:#F6F4EE; --surface-3:#ECE8DF;
  --hairline:#E3DDD0; --text:#191919; --text-muted:#6F6A60; --text-faint:#9A9486;
  --shadow:0 14px 44px rgba(25,25,25,.14),0 0 0 1px rgba(25,25,25,.05);
  --scrim:rgba(34,38,46,.42);
  /* B1/B2: 우상단 배치. 인스타 상단바와 안 겹치게 여백. 패널은 FAB 아래로 떨어짐.
     z-index: 스크림(2147483645) < 패널/FAB(2147483647) 순으로 항상 위. */
  position:fixed; right:20px; top:74px; z-index:2147483647;
  font-family:var(--font-ui); color:var(--text);
  display:flex; flex-direction:column; align-items:flex-end; gap:12px;
}
.root[data-theme="dark"]{
  --surface:#171A21; --surface-2:#1F232C; --surface-3:#272C37;
  --hairline:#2E3440; --text:#F2F1EC; --text-muted:#A2A6AE; --text-faint:#6C7079;
  --accent:#7BA7E8; --accent-ink:#0C1A30; --accent-soft:rgba(123,167,232,.16);
  --shadow:0 14px 44px rgba(0,0,0,.5),0 1px 0 rgba(255,255,255,.04) inset;
}
.hidden{display:none !important}

/* FAB → 알약(pill): 아이콘 + "댓글 수집" 라벨. 네이비 배경·흰 글씨·Pretendard. */
.fab{height:48px;padding:0 18px 0 15px;border-radius:var(--r-full);background:var(--accent);border:0;cursor:pointer;
  display:inline-flex;align-items:center;gap:9px;box-shadow:var(--shadow);transition:transform .2s var(--ease-out),filter .15s;
  position:relative;margin-left:auto;white-space:nowrap;font-family:var(--font-ui);
  /* B1: 시선을 끄는 부드러운 펄스(scale). 산만하지 않게 느린 주기. 진행 중엔 멈춤(.fab.busy). */
  animation:fabPulse 2.6s var(--ease-out) infinite}
.fab.busy{animation:none}
.fab:hover{transform:translateY(-2px) scale(1.03);animation:none;filter:brightness(1.06)}
.fab svg{width:22px;height:22px;stroke:var(--accent-ink);flex:0 0 auto}
.fab-label{color:var(--accent-ink);font-size:14px;font-weight:700;letter-spacing:-.01em;line-height:1}
@keyframes fabPulse{
  0%,100%{transform:translateY(0) scale(1)}
  50%{transform:translateY(0) scale(1.06)}}
/* B1: ping 강화 — 더 큰 링 + 브랜드 톤 글로우 두 겹 */
.fab .ping{position:absolute;inset:0;border-radius:var(--r-full);pointer-events:none;
  animation:ping 2.6s var(--ease-out) infinite}
.fab.busy .ping{display:none}
@keyframes ping{
  0%{box-shadow:0 0 0 0 rgba(27,58,107,.45),0 0 0 0 var(--accent-soft)}
  70%{box-shadow:0 0 0 14px rgba(27,58,107,0),0 0 0 22px transparent}
  100%{box-shadow:0 0 0 0 rgba(27,58,107,0),0 0 0 0 transparent}}

/* B3 스크림은 shadow 밖(document.body)에 인라인 스타일로 붙는다(showScrim 참고) —
   shadow CSS는 light-DOM 엘리먼트에 적용되지 않으므로 여기 두지 않는다. */

/* panel */
.panel{width:336px;background:var(--surface);border:1px solid var(--hairline);border-radius:var(--r-lg);
  box-shadow:var(--shadow);overflow:hidden;animation:rise .26s var(--ease-out)}
@keyframes rise{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.p-head{display:flex;align-items:center;gap:10px;padding:14px var(--sp-4);border-bottom:1px solid var(--hairline)}
.p-mark{width:26px;height:26px;border-radius:7px;background:var(--accent);display:grid;place-items:center;flex:0 0 auto}
.p-mark svg{width:16px;height:16px;stroke:var(--accent-ink)}
.p-title{display:flex;flex-direction:column;line-height:1.25;margin-right:auto;min-width:0}
.p-title b{font-size:13.5px;font-weight:700;letter-spacing:-.01em}
.p-title span{font-size:11px;color:var(--text-faint);font-weight:500}
.p-x{width:28px;height:28px;border-radius:var(--r-sm);border:0;background:none;color:var(--text-muted);cursor:pointer;
  font-size:17px;display:grid;place-items:center;line-height:1}
.p-x:hover{background:var(--surface-3);color:var(--text)}
.p-body{padding:var(--sp-3) var(--sp-4) var(--sp-4)}
.sec-l{font-size:11px;font-weight:700;color:var(--text-faint);letter-spacing:.05em;text-transform:uppercase;margin:6px 2px 10px}

/* option row + toggle */
.opt{display:flex;gap:12px;align-items:flex-start;padding:11px 12px;border-radius:var(--r-md);cursor:pointer;
  transition:background .12s;border:0;background:none;width:100%;text-align:left;font-family:var(--font-ui)}
.opt:hover{background:var(--surface-2)}
.opt+.opt{margin-top:2px}
.opt .meta{flex:1;min-width:0}
.opt .meta b{font-size:13px;font-weight:600;display:block;color:var(--text)}
.opt .meta p{font-size:11.5px;color:var(--text-muted);margin-top:2px;line-height:1.4}
.chip{display:inline-flex;align-items:center;gap:4px;margin-top:6px;font-size:10.5px;font-weight:600;color:var(--warning);
  background:rgba(245,158,11,.12);padding:3px 7px;border-radius:var(--r-full)}
.sw{flex:0 0 auto;width:38px;height:22px;border-radius:var(--r-full);background:var(--surface-3);border:1px solid var(--hairline);
  position:relative;transition:.18s var(--ease-out);margin-top:1px}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--text-muted);transition:.18s var(--ease-out)}
.opt[data-on="1"] .sw{background:var(--accent);border-color:var(--accent)}
.opt[data-on="1"] .sw::after{left:18px;background:var(--accent-ink)}

/* primary CTA */
.cta{width:100%;margin-top:var(--sp-4);height:44px;border:0;border-radius:var(--r-md);background:var(--accent);
  color:var(--accent-ink);font-family:var(--font-ui);font-size:14px;font-weight:700;cursor:pointer;
  display:flex;align-items:center;justify-content:center;gap:8px;transition:.15s}
.cta:hover{filter:brightness(1.08)}
.cta svg{width:17px;height:17px;stroke:currentColor}
.foot{text-align:center;font-size:10.5px;color:var(--text-faint);margin-top:10px}
.foot b{color:var(--text-muted);font-weight:600;font-family:var(--font-mono)}

/* progress state */
.read{display:flex;align-items:baseline;gap:8px;padding:6px 2px 14px}
.read .n{font-family:var(--font-mono);font-size:34px;font-weight:700;letter-spacing:-.02em;color:var(--accent);line-height:1}
.read .u{font-size:13px;color:var(--text-muted);font-weight:500}
.read .st{margin-left:auto;font-size:11px;color:var(--text-muted);font-family:var(--font-mono);display:flex;align-items:center;gap:6px}
.live{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:blink 1s steps(2) infinite}
@keyframes blink{50%{opacity:.25}}
.track{height:8px;border-radius:var(--r-full);background:var(--surface-3);overflow:hidden;position:relative}
.fill{height:100%;width:0%;border-radius:var(--r-full);background:var(--accent);position:relative;overflow:hidden;
  transition:width .3s var(--ease-out)}
.fill::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);
  transform:translateX(-100%);animation:scan 1.3s linear infinite}
@keyframes scan{to{transform:translateX(100%)}}
/* indeterminate (총량 미상) — '작업 중' 스윕 */
.track.indet .fill{width:40%;animation:sweep 1.5s cubic-bezier(.65,.05,.36,1) infinite}
@keyframes sweep{0%{transform:translateX(-135%)}100%{transform:translateX(312%)}}
.working{display:inline-flex;align-items:center;gap:7px;font-family:var(--font-ui);font-weight:600;color:var(--text-muted);font-size:12px}
.working .ell::after{content:"";animation:ell 1.4s steps(4,end) infinite}
@keyframes ell{0%{content:""}25%{content:"·"}50%{content:"··"}75%{content:"···"}}
.meta-row{display:flex;justify-content:space-between;align-items:center;font-family:var(--font-mono);font-size:11px;color:var(--text-faint);margin-top:9px}
.stop{width:100%;margin-top:var(--sp-4);height:40px;border:1px solid var(--hairline);border-radius:var(--r-md);background:transparent;
  color:var(--danger);font-family:var(--font-ui);font-size:13px;font-weight:600;cursor:pointer}
.stop:hover{background:rgba(239,68,68,.08)}

/* done state */
.done-ic{width:48px;height:48px;border-radius:50%;background:var(--accent-soft);display:grid;place-items:center;margin:6px auto 12px}
.done-ic svg{width:26px;height:26px;stroke:var(--accent)}
.done h3{text-align:center;font-size:16px;font-weight:700;color:var(--text)}
.done .big{text-align:center;font-family:var(--font-mono);font-size:13px;color:var(--text-muted);margin-top:4px}
.done .big b{color:var(--accent);font-weight:700}
.summary{display:flex;gap:8px;margin:16px 0 4px}
.stat{flex:1;background:var(--surface-2);border:1px solid var(--hairline);border-radius:var(--r-md);padding:10px 8px;text-align:center}
.stat .v{font-family:var(--font-mono);font-size:18px;font-weight:700;color:var(--text)}
.stat .k{font-size:10.5px;color:var(--text-faint);margin-top:2px}

/* error note */
.errnote{margin-top:12px;padding:10px 12px;border-radius:var(--r-md);background:rgba(239,68,68,.08);
  border:1px solid rgba(239,68,68,.25);font-size:12px;color:var(--danger);line-height:1.5}
`;

  // 조준경(crosshair) 마크 SVG
  const MARK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';

  const PANEL_HTML = `
<div class="root" data-theme="light">
  <!-- FAB → 알약(pill): 아이콘 + "댓글 수집" 라벨 -->
  <button class="fab" data-only="fab" type="button" title="인스타 댓글 스카우트" aria-label="댓글 수집">
    <span class="ping"></span>
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><path d="M12 .5v5M12 18.5v5M.5 12h5M18.5 12h5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>
    <span class="fab-label">댓글 수집</span>
  </button>

  <!-- OPTIONS -->
  <div class="panel hidden" data-only="options">
    <div class="p-head">
      <span class="p-mark">${MARK_SVG}</span>
      <div class="p-title"><b>댓글 스카우트</b><span>인스타그램 댓글 추출 · 한끗랩</span></div>
      <button class="p-x" type="button" data-act="close">✕</button>
    </div>
    <div class="p-body">
      <div class="sec-l">추출 옵션</div>
      <button class="opt" type="button" data-opt="excludeAuthor" data-on="0">
        <div class="meta"><b>게시물 작성자 댓글 제외</b><p>계정 본인이 단 답글은 결과에서 빼요.</p></div>
        <span class="sw"></span>
      </button>
      <button class="opt" type="button" data-opt="weightMention" data-on="1">
        <div class="meta"><b>멘션 댓글 2배 가중</b><p>친구를 @태그한 댓글은 결과에 한 줄 더 추가해요.</p></div>
        <span class="sw"></span>
      </button>
      <button class="opt" type="button" data-opt="includeReplies" data-on="0">
        <div class="meta"><b>대댓글까지 수집</b><p>답글이 달린 댓글도 펼쳐서 모아요.</p>
          <span class="chip">⏱ 댓글이 많으면 느려질 수 있어요</span></div>
        <span class="sw"></span>
      </button>
      <button class="cta" type="button" data-act="start">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        추출 시작
      </button>
      <div class="foot">이 게시물 댓글을 자동 스크롤로 모아요</div>
    </div>
  </div>

  <!-- PROGRESS -->
  <div class="panel hidden" data-only="progress">
    <div class="p-head">
      <span class="p-mark">${MARK_SVG}</span>
      <div class="p-title"><b>추출하는 중…</b><span>창을 닫아도 백그라운드에서 계속돼요</span></div>
      <button class="p-x" type="button" data-act="minimize">—</button>
    </div>
    <div class="p-body">
      <div class="read"><span class="n" data-bind="count">0</span><span class="u">개 수집</span>
        <span class="st"><span class="live"></span>SCANNING</span></div>
      <div class="track indet"><div class="fill"></div></div>
      <div class="meta-row"><span class="working">댓글을 끝까지 모으는 중<span class="ell"></span></span><span>중지 가능</span></div>
      <button class="stop" type="button" data-act="stop">중지하고 지금까지 저장</button>
    </div>
  </div>

  <!-- DONE -->
  <div class="panel hidden" data-only="done">
    <div class="p-head">
      <span class="p-mark">${MARK_SVG}</span>
      <div class="p-title"><b>댓글 스카우트</b><span data-bind="doneSub">추출 완료</span></div>
      <button class="p-x" type="button" data-act="close">✕</button>
    </div>
    <div class="p-body">
      <div class="done">
        <div class="done-ic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>
        <h3 data-bind="doneTitle">추출 완료</h3>
        <div class="big"><b data-bind="doneCount">0</b>개 댓글을 모았어요</div>
      </div>
      <div class="summary">
        <div class="stat"><div class="v" data-bind="statTotal">0</div><div class="k">댓글</div></div>
        <div class="stat"><div class="v" data-bind="statUnique">0</div><div class="k">고유 계정</div></div>
        <div class="stat"><div class="v" data-bind="statMention">0</div><div class="k">멘션 가중</div></div>
      </div>
      <button class="cta" type="button" data-act="download">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>
        엑셀(.xlsx) 다운로드
      </button>
      <div class="foot">파일명 <b data-bind="fileName">insta-comment.xlsx</b></div>
    </div>
  </div>

  <!-- ERROR (done 패널 재사용 대신 별도 표시) -->
  <div class="panel hidden" data-only="error">
    <div class="p-head">
      <span class="p-mark">${MARK_SVG}</span>
      <div class="p-title"><b>추출 실패</b><span>다시 시도해 주세요</span></div>
      <button class="p-x" type="button" data-act="close">✕</button>
    </div>
    <div class="p-body">
      <div class="errnote" data-bind="errMsg">댓글을 찾지 못했습니다. 게시물을 열고 댓글 영역이 보이게 한 뒤 다시 시도하세요.</div>
      <button class="cta" type="button" data-act="retry" style="margin-top:14px">다시 시도</button>
    </div>
  </div>
</div>`;

  // UI 상태 보관
  const state = {
    view: 'fab',          // fab | options | progress | done | error
    options: {
      excludeAuthor: false,
      weightMention: true,
      includeReplies: false,
    },
    collecting: false,
    cancelRequested: false,
    lastResult: null,     // { records, uniqueAccounts, mentionWeighted, total }
    lastWorkbook: null,    // SheetJS workbook (다운로드용)
    lastFileName: '',
  };

  let shadowRoot = null;
  let hostEl = null;

  /** shadow 내부 셀렉터 헬퍼. */
  function $(sel) { return shadowRoot.querySelector(sel); }
  function $$(sel) { return Array.from(shadowRoot.querySelectorAll(sel)); }
  function bind(name) { return shadowRoot.querySelector(`[data-bind="${name}"]`); }

  /** 화면 전환 — design-preview의 setState와 동일 매핑. */
  function setView(view) {
    state.view = view;
    $$('[data-only]').forEach(el => {
      el.classList.toggle('hidden', el.dataset.only !== view);
    });
  }

  /** 인스타 다크모드 감지 → best-effort 테마 전환. [튜닝] html color-scheme 기반. */
  function applyTheme() {
    let dark = false;
    try {
      const cs = document.documentElement.style.colorScheme || '';
      const bodyBg = getComputedStyle(document.body).backgroundColor || '';
      // 인스타 다크모드는 html에 color-scheme:dark 또는 어두운 배경
      if (cs.includes('dark')) dark = true;
      else if (bodyBg) {
        const m = bodyBg.match(/\d+/g);
        if (m && m.length >= 3) {
          const lum = (parseInt(m[0]) * 0.299 + parseInt(m[1]) * 0.587 + parseInt(m[2]) * 0.114);
          if (lum < 90) dark = true;
        }
      }
    } catch (e) { /* 무시 — 기본 라이트 유지 */ }
    const root = $('.root');
    if (root) root.dataset.theme = dark ? 'dark' : 'light';
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 2. UI 주입 + 이벤트 배선
  // ────────────────────────────────────────────────────────────────────────────
  function mountUI() {
    if (hostEl) return;
    injectFonts();

    hostEl = document.createElement('div');
    hostEl.id = 'ice-insta-comment-host';
    // 호스트 자체는 위치만 잡고 실제 위젯은 shadow 내부 .root가 fixed(top/right)로 배치.
    // B1/B2: 우상단. z-index 최상위(스크림보다 위).
    hostEl.style.cssText = 'all:initial;position:fixed;right:0;top:0;width:0;height:0;z-index:2147483647';
    document.body.appendChild(hostEl);

    shadowRoot = hostEl.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = STYLE;
    shadowRoot.appendChild(styleEl);
    const wrap = document.createElement('div');
    wrap.innerHTML = PANEL_HTML;
    shadowRoot.appendChild(wrap.firstElementChild);

    applyTheme();
    wireEvents();
    setView('fab');
    updateFabVisibility(); // 게시물 페이지인지 즉시 판정
  }

  function wireEvents() {
    // FAB → 옵션
    $('.fab').addEventListener('click', () => {
      applyTheme();
      // 진행 중이면 진행 화면, 완료 결과 있으면 완료 화면으로 복귀
      if (state.collecting) setView('progress');
      else if (state.lastResult) setView('done');
      else setView('options');
    });

    // 옵션 토글
    $$('.opt').forEach(btn => {
      // 초기 옵션값을 state와 동기화
      const key = btn.dataset.opt;
      btn.dataset.on = state.options[key] ? '1' : '0';
      btn.addEventListener('click', () => {
        const on = btn.dataset.on === '1';
        btn.dataset.on = on ? '0' : '1';
        state.options[key] = !on;
      });
    });

    // 공통 액션 버튼
    shadowRoot.addEventListener('click', e => {
      const actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      const act = actEl.dataset.act;
      if (act === 'close') setView('fab');
      else if (act === 'minimize') setView('fab');
      else if (act === 'start') startCollection();
      else if (act === 'stop') { state.cancelRequested = true; }
      else if (act === 'download') downloadExcel();
      else if (act === 'retry') setView('options');
    });
  }

  /** 진행 UI 직접 갱신 (같은 content 컨텍스트).
   *  인스타가 전체 댓글 수(분모)를 신뢰성 있게 주지 않아 %를 못 낸다 →
   *  진행바는 항상 불확정(.track.indet 스윕), 실제 진행 신호는 mono 카운터(N개 수집)가 담당. */
  function renderProgress(done) {
    const cnt = bind('count'); if (cnt) cnt.textContent = formatNum(done);
  }

  function renderDone(result, fileName) {
    bind('doneTitle').textContent = '추출 완료';
    bind('doneSub').textContent = '추출 완료';
    bind('doneCount').textContent = formatNum(result.total);
    bind('statTotal').textContent = formatNum(result.total);
    bind('statUnique').textContent = formatNum(result.uniqueAccounts);
    bind('statMention').textContent = formatNum(result.mentionWeighted);
    bind('fileName').textContent = fileName;
  }

  function showError(message) {
    const el = bind('errMsg');
    if (el) el.textContent = message || '추출 중 오류가 발생했습니다.';
    setView('error');
  }

  function formatNum(n) {
    return (n == null ? 0 : n).toLocaleString('en-US');
  }

  // ── B3: 회색 스크림 (shadow 밖, document.body 직속) ──────────────────────────
  // 추출 중 유저의 클릭/스크롤을 흡수해 수집이 깨지는 것을 막고, 자동스크롤
  // 깜빡임을 가린다. host(.root)는 z-index 2147483647로 스크림(…645) 위에 떠서
  // 진행 패널·중지 버튼이 항상 보인다.
  // ⚠️ 엔진의 scrollIntoView/scrollBy는 window/노드를 직접 움직이므로 스크림과
  //    무관하다(스크림은 포인터/시각 차단일 뿐, 프로그램적 스크롤을 막지 않는다).
  let scrimEl = null;
  function showScrim() {
    if (scrimEl) return;
    scrimEl = document.createElement('div');
    scrimEl.id = 'ice-insta-comment-scrim';
    scrimEl.style.cssText = [
      'all:initial', 'position:fixed', 'inset:0', 'z-index:2147483645',
      'background:rgba(34,38,46,.42)',
      'backdrop-filter:saturate(.85) blur(.5px)',
      '-webkit-backdrop-filter:saturate(.85) blur(.5px)',
      'pointer-events:auto', 'cursor:progress',
      'transition:opacity .25s cubic-bezier(.16,1,.3,1)', 'opacity:0',
    ].join(';');
    // 유저 입력만 차단(엔진 스크롤엔 영향 없음). wheel/touch/click 흡수.
    const block = e => { e.preventDefault(); e.stopPropagation(); };
    ['wheel', 'touchmove', 'click', 'mousedown', 'keydown'].forEach(ev => {
      scrimEl.addEventListener(ev, block, { passive: false });
    });
    document.body.appendChild(scrimEl);
    // 다음 프레임에 페이드인
    requestAnimationFrame(() => { if (scrimEl) scrimEl.style.opacity = '1'; });
  }
  function hideScrim() {
    if (!scrimEl) return;
    const el = scrimEl;
    scrimEl = null;
    el.style.opacity = '0';
    setTimeout(() => { try { el.remove(); } catch (e) { /* 무시 */ } }, 280);
  }

  /** FAB 펄스/ping 애니메이션 토글 (진행 중이면 멈춤). */
  function setFabBusy(busy) {
    const fab = $('.fab');
    if (fab) fab.classList.toggle('busy', !!busy);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 3. background 통신 (single-writer: content는 메시지만, storage엔 안 씀)
  // ────────────────────────────────────────────────────────────────────────────
  function reportToBackground(payload) {
    try {
      // background가 죽어있어도(SW idle) sendMessage가 깨우므로 그대로 보낸다.
      chrome.runtime.sendMessage(payload, () => {
        // 응답/에러 무시 — 상태 기록은 best-effort. UI는 content가 직접 갱신.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // 확장 컨텍스트 무효화(업데이트/리로드) 등 — 수집 자체는 계속 진행.
    }
  }

  /**
   * background 응답(ack)을 기다리는 보고. job.start에만 사용한다.
   * ⚠️ 메시지 순서 보장(single-writer): job.start의 ack(레코드
   * 생성 완료)를 받은 뒤에야 수집 루프가 job.progress를 보내야 한다. ack 없이
   * 곧장 루프를 돌면 첫 progress가 start보다 먼저 처리돼(레코드 status!=='running')
   * background에서 버려진다. 그래서 start만 응답을 await한다.
   * background가 죽어있어도 best-effort — 실패해도 수집 자체는 진행한다(resolve).
   */
  function reportAndWait(payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(payload, response => {
          void chrome.runtime.lastError; // SW idle 등 무시
          resolve(response || null);
        });
      } catch (e) {
        resolve(null); // 컨텍스트 무효화 등 — 수집은 계속
      }
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 4. 수집 엔진 — 자동 스크롤 + 새 노드 감지 + 댓글 추출
  // ────────────────────────────────────────────────────────────────────────────
  //
  // [셀렉터 전략 — 방어적, 클래스명 의존 금지]
  //  인스타 댓글 DOM은 빌드마다 바뀐다. 그래서:
  //   - 댓글 컨테이너: 게시물 내 스크롤 가능한 영역을 "스크롤 가능 + 댓글 핸들 링크
  //     다수 포함" 휴리스틱으로 찾는다. 못 찾으면 window 스크롤로 폴백.
  //   - 댓글 단위: `ul li` 구조 안에서 (작성자 핸들 링크 + 시간 + 텍스트)를 가진
  //     블록을 댓글로 본다. role/구조 기반.
  //   - 작성자 핸들: `a[href^="/"][role="link"]` 중 href가 `/<handle>/` 형태인 첫 링크.
  //   - 시간: `time[datetime]`의 datetime(ISO) 우선, 없으면 표시 텍스트.
  //  ⚠️ 실제 인스타에서 가장 깨지기 쉬운 지점:
  //   (a) 댓글 li 식별 (b) 본문 텍스트 추출(작성자명/번역버튼 섞임) (c) 답글 펼침 버튼 문구.
  //   각 지점에 폴백을 뒀고, 사용자가 아래 상수만 고쳐 튜닝할 수 있게 분리했다.

  // [튜닝] 답글 펼침("답글 보기(N개)") 버튼 문구. 부분매칭(includes)으로 "답글 보기(1개)" 변형 커버.
  //   ⚠️ 실측(CDP): 답글 펼침은 <button>"답글 보기(N개)"</button>, 답글 입력은 <button>"답글 달기"</button>.
  //      단독 '답글'을 넣으면 "답글 달기"(입력창)를 오클릭하므로 절대 금지. REPLY_DENY로 명시 제외.
  const REPLY_BUTTON_TEXTS = ['답글 보기', '답글 모두 보기', '모두 보기', 'view replies', 'view all replies', 'more replies', 'show replies'];
  // [튜닝] 답글 펼침에서 명시 제외할 문구 — "답글 달기"(reply 입력창)·숨기기·번역 등.
  const REPLY_DENY_TEXTS = ['답글 달기', '답글달기', 'reply', '숨기기', 'hide'];
  // [튜닝] "답글 숨기기" 류 — 펼침 대상에서 제외
  const HIDE_BUTTON_TEXTS = ['숨기기', 'hide'];
  // [튜닝] A2: 상위 댓글 "더 불러오기"(load-more) 버튼 문구. 답글 버튼과 구분해 별도로 클릭.
  //   ⚠️ 실측(CDP): 정확 문구는 "댓글 더 읽어들이기". 다른 빌드/로케일 대비 변형도 포함. 부분매칭.
  const LOADMORE_BUTTON_TEXTS = ['댓글 더 읽어들이기', '더 읽어들이기', '댓글 더 보기', '댓글 더보기', '더 불러오기', 'load more comments', 'load more', 'view more comments', 'more comments', 'see more comments'];

  // A3: 종료 판정 분리 — 스피너 로딩 대기엔 관대, 정체엔 빠르게.
  const ROUND_DELAY_MS = 1000;     // 라운드 사이 대기 (스피너 로딩 여유)
  const EMPTY_ROUNDS_LIMIT = 60;   // 댓글 0개 라운드 연속 한도 — 스피너가 떠 있을 때(로딩 중)만 관대.
  const NO_SPINNER_EMPTY_LIMIT = 4; // 스피너가 없는데도 신규 0개면 = 바닥 도달 → 빠르게 종료(긴 dead-tail 방지).
  const STALE_ROUNDS_LIMIT = 20;   // 댓글 수 정체 라운드 연속 한도
  const MAX_SCROLLS = 1200;        // 안전 상한 (무한루프 방지)

  // A1: 인스타 댓글 로딩 스피너 셀렉터.
  const LOADING_SPINNER_SEL = '[data-visualcompletion="loading-state"]';
  // A6: 움짤/GIF/스티커 이미지 src 패턴 (프로필 사진은 제외).
  //   실측(CDP): 인스타 GIF 스티커 댓글은 `cdn.fbsbx.com/v/t59.2708-21/...` 로 렌더된다(giphy/tenor 아님).
  //   t59. (영상/스티커 cdn) 와 외부 GIF 호스트를 함께 커버. 프로필 사진(t51.*-19/)은 PROFILE_PIC_RE로 제외.
  const GIF_SRC_RE = /giphy|tenor|\.gif(\?|$)|fbcdn\.net\/[^\s"']*emg|fbsbx\.com|\/t59\./i;
  const PROFILE_PIC_RE = /\/t51\.[^/]*-19\/|profile_pic/i;
  // A5: 댓글 많을 때 답글 클릭 적응형 감속 임계.
  const HEAVY_COMMENT_THRESHOLD = 2000;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * A5: 합성 클릭 — el.click() 단발은 인스타 React 핸들러가 무시할 수 있어
   * pointerdown→mousedown→mouseup→pointerup→click 시퀀스를 발사한다.
   * A2(load-more)·A5(답글) 클릭에 공용.
   */
  function syntheticClick(el) {
    if (!el) return;
    try {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + Math.min(rect.width, 10);
      const cy = rect.top + Math.min(rect.height, 10);
      const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };
      const pe = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerdown', pe));
      el.dispatchEvent(new MouseEvent('mousedown', base));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new PointerEvent('pointerup', pe));
      el.dispatchEvent(new MouseEvent('click', base));
    } catch (e) {
      // PointerEvent 미지원 등 — 폴백으로 네이티브 click
      try { el.click(); } catch (e2) { /* 무시 */ }
    }
  }

  /** 버튼류 라벨(텍스트 + aria-label) 소문자 합본. A2/A5 매칭 공용. */
  function buttonLabel(el) {
    const txt = (el.textContent || '').trim();
    const aria = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
    return (txt + ' ' + aria).trim().toLowerCase();
  }

  /** 게시물 작성자 핸들 추정. [튜닝] 헤더 영역 첫 핸들 링크. */
  function detectAuthorHandle() {
    try {
      // 게시물 상단 헤더의 작성자 링크 — article 내 첫 핸들 링크 휴리스틱
      const article = document.querySelector('article') || document.body;
      const links = article.querySelectorAll('a[href^="/"][role="link"], header a[href^="/"]');
      for (const a of links) {
        const h = handleFromHref(a.getAttribute('href'));
        if (h) return h;
      }
    } catch (e) { /* 무시 */ }
    return '';
  }

  /** href("/somebody/")에서 핸들 추출. 게시물/탐색/태그 등 경로는 제외. */
  function handleFromHref(href) {
    if (!href) return '';
    const m = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
    if (!m) return '';
    const h = m[1];
    // 인스타 예약 경로 제외
    const reserved = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'direct', 'accounts', 'about', 'tags', 'tv']);
    if (reserved.has(h.toLowerCase())) return '';
    return h;
  }

  /**
   * 댓글 스크롤 컨테이너 탐색.
   * [튜닝] 가장 깨지기 쉬움 — overflow scroll + 핸들 링크 여러 개 포함하는 요소를 고른다.
   */
  function findScrollContainer() {
    const candidates = [];
    const all = document.querySelectorAll('article *, div[role="dialog"] *');
    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      const scrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll');
      if (!scrollable) continue;
      if (el.scrollHeight <= el.clientHeight + 4) continue;
      // 내부에 핸들 링크가 충분히 있어야 댓글 영역으로 본다
      const linkCount = el.querySelectorAll('a[href^="/"]').length;
      if (linkCount < 3) continue;
      candidates.push({ el, linkCount });
    }
    candidates.sort((a, b) => b.linkCount - a.linkCount);
    return candidates.length ? candidates[0].el : null;
  }

  /**
   * A1 [치명]: 스크롤 앵커 = "로딩 스피너 추적" 우선.
   * 인스타가 window 스크롤로 댓글을 로드하면 컨테이너-한정 스크롤은 한 개도 더 못 부른다.
   * 우선순위:
   *   1) 로딩 스피너가 있으면 그 경계를 scrollIntoView로 계속 따라간다(로딩 경계 추적).
   *   2) 없으면 마지막 댓글 노드를 화면 끝으로.
   *   3) 그래도 없으면 window.scrollBy.
   * 컨테이너를 찾았으면 보조로 같이 내려주되, window/스피너 스크롤이 1차.
   * @param {Element[]} nodes 이번 라운드까지 발견한 댓글 노드(마지막 노드 앵커용)
   * @param {Element|null} container 보조 스크롤 컨테이너(있으면)
   */
  function scrollStep(nodes, container) {
    // 1차: 스피너 또는 마지막 댓글 노드를 화면 끝으로(로딩 경계 추적).
    try {
      const spinner = document.querySelector(LOADING_SPINNER_SEL);
      if (spinner) {
        spinner.scrollIntoView({ behavior: 'smooth', block: 'end' });
      } else if (nodes && nodes.length) {
        nodes[nodes.length - 1].scrollIntoView({ block: 'end' });
      }
    } catch (e) { /* 무시 — window 폴백 */ }
    // 핵심: window 스크롤로 lazy-load 트리거. 실측상 댓글은 컨테이너가 아닌 window 스크롤로 로드된다.
    //   scrollIntoView가 먹은 경우에도 추가로 window를 바닥까지 내려 로딩을 확실히 자극한다.
    try {
      window.scrollTo(0, document.documentElement.scrollHeight);
    } catch (e) {
      try { window.scrollBy(0, 800); } catch (e2) { /* 무시 */ }
    }
    // 보조(다른 레이아웃=피드 모달 대비): 컨테이너가 있으면 같이 내린다(1차는 위의 window).
    if (container) {
      try { container.scrollTop = container.scrollHeight; } catch (e) { /* 무시 */ }
    }
  }

  /**
   * A2: 상위 댓글 "더 불러오기"(load-more) 버튼 클릭. 답글 버튼(A5)과 구분.
   * 식별: aria-label/텍스트가 LOADMORE 매칭, 또는 "+" 단독/플러스 svg 아이콘 버튼.
   * 이미 처리한 버튼은 hkLoadmore 마킹. 합성 클릭 사용.
   */
  /**
   * 현재 DOM에 "댓글 더 읽어들이기" 류 load-more 버튼이 (마킹 무관) 존재하는지.
   * 종료 게이트용 — 버튼이 남아 있으면 아직 더 불러올 댓글이 있으므로 루프를 계속한다.
   */
  function hasLoadMoreButton(scope) {
    const root = scope || document.querySelector('article') || document.body;
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      const label = buttonLabel(el);
      if (REPLY_DENY_TEXTS.some(d => label.includes(d.toLowerCase()))) continue;
      if (REPLY_BUTTON_TEXTS.some(r => label.includes(r.toLowerCase()))) continue;
      if (HIDE_BUTTON_TEXTS.some(h => label.includes(h))) continue;
      if (LOADMORE_BUTTON_TEXTS.some(t => label.includes(t.toLowerCase()))) return true;
    }
    return false;
  }

  function clickLoadMore(scope) {
    const root = scope || document.querySelector('article') || document.body;
    const btns = root.querySelectorAll('button, [role="button"]');
    let clicked = 0;
    for (const el of btns) {
      // 같은 노드 재클릭만 방지. 인스타는 클릭 후 이 버튼 노드를 제거하고 새 버튼을 만들므로,
      // 다음 라운드의 "새" 버튼은 마킹이 없어 다시 클릭된다(끝까지 펼침).
      if (el.dataset && el.dataset.hkLoadmore === '1') continue;
      const label = buttonLabel(el);
      // 답글 입력("답글 달기")·답글 펼침·숨기기는 여기서 처리하지 않는다(오클릭 방지).
      if (REPLY_DENY_TEXTS.some(d => label.includes(d.toLowerCase()))) continue;
      if (REPLY_BUTTON_TEXTS.some(r => label.includes(r.toLowerCase()))) continue;
      if (HIDE_BUTTON_TEXTS.some(h => label.includes(h))) continue;

      // 실측 정확 문구 "댓글 더 읽어들이기" 포함 — 텍스트 정확매칭(부분포함)만. "+" svg 추측 제거(오클릭 위험).
      const isLoadMore = LOADMORE_BUTTON_TEXTS.some(t => label.includes(t.toLowerCase()));
      if (!isLoadMore) continue;
      try {
        el.scrollIntoView({ block: 'center' });
        syntheticClick(el);
        if (el.dataset) el.dataset.hkLoadmore = '1';
        clicked++;
      } catch (e) { /* 무시 */ }
    }
    return clicked;
  }

  /**
   * 현재 DOM에서 댓글 후보 요소들을 수집.
   * [튜닝] li 구조 + (핸들 링크 & 시간) 보유를 댓글로 판정. 캡션/광고/시스템행 제외.
   */
  /** li가 "유효 핸들 anchor"를 가졌는지(예약경로 제외). A4 점수화용. */
  function liHasValidHandle(li) {
    for (const a of li.querySelectorAll('a[href^="/"]')) {
      if (handleFromHref(a.getAttribute('href'))) return true;
    }
    return false;
  }

  // [튜닝] 댓글 액션 affordance 라벨 — 캡션(본문)에는 없고 진짜 댓글에만 있다.
  //   실측(CDP, 2026-06-23, /p/DZ6QsncO8_7): 진짜 댓글 li는 "좋아요 N개/답글 달기/댓글 옵션"
  //   버튼을 갖고 time이 `/p/<id>/c/<commentId>/` permalink 링크로 감싸진다. 캡션 li는 둘 다 없다.
  const COMMENT_ACTION_TEXTS = ['답글 달기', '답글달기', 'reply', '좋아요', 'like', '댓글 옵션', 'comment options'];

  /**
   * ★ 캡션(게시물 본문) 제외 — 클래스 독립·견고. (옵션과 무관, 항상 제외)
   *  time→li로 잡힌 노드 중 "게시물 작성자의 캡션(본문)"이 첫 댓글로 섞인다. 캡션은 댓글 목록
   *  ul과 다른 ul(난독화 클래스, 의존 금지)에 있고 **댓글 액션 affordance가 없다**.
   *
   *  실측(CDP)으로 판정한 견고 로직 = affordance 기반(조합):
   *   - 진짜 댓글 li: time이 `/c/` 댓글 permalink 링크로 감싸짐  OR  댓글 액션 버튼(답글 달기/
   *     좋아요/댓글 옵션) 보유. (답글/대댓글도 `/c/` permalink가 있어 함께 유지됨 — 실측 확인)
   *   - 캡션 li: 둘 다 없음 → 제외.
   *
   *  ⚠️ approach (a)"댓글 li가 가장 많은 ul=진짜 목록"은 폐기 — 실측상 인스타는 댓글마다 별개
   *     `ul._a9ym`(li 1개씩)을 쓴다. "최다 ul" 그룹핑이 성립하지 않아 캡션 1개만 떼어낼 수 없다.
   *     그래서 노드 단위 affordance 판정(b)이 유일하게 견고. 실측: time→li 93개 중 캡션 1개만
   *     affordance 없음 → 정확히 1개 제외, 답글 포함 92개 유지(작성자 핀댓글 포함).
   */
  function liIsComment(li) {
    // (1) time이 댓글 permalink(/c/)로 감싸졌는가 — 가장 안정적 신호.
    const t = li.querySelector('time[datetime]') || li.querySelector('time');
    if (t) {
      const a = t.closest('a[href]');
      if (a && (a.getAttribute('href') || '').includes('/c/')) return true;
    }
    // (2) 폴백: 댓글 액션 버튼(답글 달기/좋아요/댓글 옵션) 보유 — 캡션엔 없다.
    //     다른 빌드/로케일에서 permalink 구조가 달라도 액션 버튼으로 회복.
    for (const b of li.querySelectorAll('button, [role="button"]')) {
      const lab = ((b.textContent || '') + ' ' + ((b.getAttribute && b.getAttribute('aria-label')) || '')).toLowerCase();
      if (COMMENT_ACTION_TEXTS.some(x => lab.includes(x.toLowerCase()))) return true;
    }
    return false;
  }

  /**
   * 댓글 li 후보 수집 — time[datetime]→li 를 PRIMARY로.
   *  ⚠️ 실측(CDP, 2026-06): 인스타 게시물 페이지의 댓글 구조는
   *     `UL._a9ym > DIV[role="button"] > LI._a9zj > …` 이라 **UL 직계 자식이 li가 아니라
   *     div[role=button]**이다. 따라서 "ul 직계 li 밀도" 방식은 0개를 반환한다.
   *     반면 모든 댓글 li는 `time[datetime]` 을 정확히 1개씩 가지므로(게시물 캡션의
   *     time만 closest('li')가 null이라 자연 배제) time→closest('li')가 가장 견고하다.
   *     실측 16 time 중 15 li 획득(캡션 time 1개 제외).
   *
   *  1차(PRIMARY): time[datetime] → closest('li'). 댓글영역 밖 li 오탐을 막기 위해
   *                 "li 안에 유효 핸들 링크(예약경로 제외)"도 있어야 채택.
   *  2차(폴백, 1차가 0개일 때만): 기존 ul li 밀도/구조 점수화 방식.
   * dedupe는 호출부(hkSeen 마킹 + seen Set)에서 유지.
   */
  function collectCommentCandidates(root) {
    // ── 1차 PRIMARY: time[datetime] → closest('li') ──
    const primary = [];
    const seenNodes = new Set();
    for (const t of root.querySelectorAll('time[datetime]')) {
      const li = t.closest('li');
      if (!li || seenNodes.has(li)) continue;
      // 댓글영역 밖 li(있다면) 배제 — 유효 핸들 링크가 있어야 댓글로 본다.
      if (!liHasValidHandle(li)) continue;
      seenNodes.add(li);
      primary.push(li);
    }
    if (primary.length) return primary;

    // ── 2차 폴백(1차가 0개일 때만): 기존 ul li 밀도/구조 방식 ──
    let lis = Array.from(root.querySelectorAll('ul li'));
    if (!lis.length) lis = Array.from(root.querySelectorAll('[role="listitem"], li'));
    const firstPassHits = lis.filter(li => li.querySelector('time') && liHasValidHandle(li)).length;
    if (firstPassHits >= 1) return lis;

    // ul 점수화
    const uls = root.querySelectorAll('ul');
    let bestUl = null, bestScore = 0;
    for (const ul of uls) {
      let score = 0;
      for (const li of ul.children) {
        if (li.tagName !== 'LI') continue;
        if (li.querySelector('time[datetime]') && liHasValidHandle(li)) score++;
      }
      if (score > bestScore) { bestScore = score; bestUl = ul; }
    }
    if (bestUl && bestScore > 0) {
      const direct = Array.from(bestUl.children).filter(c => c.tagName === 'LI');
      if (direct.length) return direct;
    }

    // closest('li, [role=listitem]') 최종 폴백
    const out = [];
    const seen2 = new Set();
    for (const t of root.querySelectorAll('time[datetime]')) {
      const li = t.closest('li, [role="listitem"]');
      if (li && !seen2.has(li)) { seen2.add(li); out.push(li); }
    }
    if (out.length) return out;
    return lis;
  }

  function findCommentNodes(scope) {
    const root = scope || document.querySelector('article') || document.body;
    const nodes = [];
    // A4: 댓글 li 후보 수집 — 폴백 체인 강화 (난독화로 단순 ul li가 깨질 때 회복).
    let lis = collectCommentCandidates(root);
    for (const li of lis) {
      // ⚡ 성능(O(N²) 회피): 이전 라운드에서 이미 댓글로 확정·처리한 li는 스킵한다.
      //   매 스크롤 라운드마다 전체 ul li를 재스캔하므로, 마킹 없이는 누적된 모든
      //   댓글에 대해 clone 포함 extractCommentText를 반복 실행하게 된다(댓글 많으면
      //   수십만 회 clone). 마킹은 DOM 노드 단위라 내용 기반 dedupe(seen Set)와 무관.
      if (li.dataset && li.dataset.hkSeen === '1') continue;
      // ⚠️ 핵심: 리프(leaf) 댓글만 수집한다. 이 li 안에 또 다른 li가 있으면
      // 이건 댓글 묶음 "래퍼"(예: 댓글+그 답글들)이므로 건너뛴다. 안 그러면
      // 래퍼의 textContent에 자식 댓글 본문이 다 합쳐져 한 줄로 들어가는 버그.
      // (래퍼는 마킹하지 않는다 — 답글 펼침으로 나중에 자식 li가 생길 수 있으므로,
      //  계속 통과시켜 새 자식 leaf를 다음 라운드에 발견할 수 있게 둔다.)
      if (li.querySelector('li')) continue;
      // ★ 캡션(게시물 본문) 제외 — 항상. 댓글 액션 affordance 없는 노드(=캡션)는 건너뛴다.
      //   작성자 본인의 "진짜 댓글"은 affordance가 있어 통과하므로, 작성자 댓글 제외는
      //   기존 excludeAuthor 옵션이 단독으로 담당한다(회귀 없음).
      if (!liIsComment(li)) continue;
      // 댓글로 보려면 핸들 링크가 있고 텍스트가 있어야 함
      const handleLink = Array.from(li.querySelectorAll('a[href^="/"]'))
        .find(a => handleFromHref(a.getAttribute('href')));
      if (!handleLink) continue;
      const selfText = extractCommentText(li, handleFromHref(handleLink.getAttribute('href')));
      if (!selfText) continue;
      // 확정된 leaf 댓글만 마킹 → 다음 라운드부터 이 li는 재추출하지 않는다.
      if (li.dataset) li.dataset.hkSeen = '1';
      nodes.push(li);
    }
    return nodes;
  }

  /**
   * 댓글 li 1개에서 본문 텍스트 추출.
   * [튜닝] 작성자명/시간/"좋아요"/"답글 달기"/"번역 보기" 등 UI 텍스트를 걸러낸다.
   */
  function extractCommentText(li, authorHandle) {
    // ── 1차 PRIMARY: span[dir="auto"] (댓글 본문 컨테이너) ──
    //   실측(CDP): 인스타 댓글 본문은 `<span dir="auto" class="_ap3a …">본문</span>`에 들어가고,
    //   사용자명·시간·"좋아요 N개·답글 달기·댓글 옵션" 액션 라벨은 dir="auto"가 아닌 별도 span에 있다.
    //   따라서 li 안의 dir="auto" span 텍스트만 모으면 사용자명/액션과 안 섞인 깨끗한 본문이 나온다.
    //   멘션(@친구)은 본문 span 내부 <a>로 렌더되어 textContent에 포함되므로 그대로 보존된다.
    try {
      const bodySpans = li.querySelectorAll('span[dir="auto"]');
      if (bodySpans.length) {
        let bt = '';
        for (const s of bodySpans) bt += (s.textContent || '') + ' ';
        bt = bt.replace(/\s+/g, ' ').trim();
        // 본문 span이 작성자명과 동일한 케이스 방어(드물게 username이 dir=auto일 때).
        const ah = (authorHandle || '').toLowerCase();
        if (bt && bt.toLowerCase() !== ah) return bt;
      }
    } catch (e) { /* 폴백으로 진행 */ }

    // ── 2차 폴백: clone 후 time/button/작성자 링크 제거(레거시 방식) ──
    const clone = li.cloneNode(true);
    // 제거 대상: time, button, 작성자 핸들 링크(@핸들 표기 중복), 액션 영역
    clone.querySelectorAll('time, [role="button"], button').forEach(n => n.remove());
    // 작성자 핸들 링크 제거 (본문이 아니라 헤더)
    clone.querySelectorAll('a[href^="/"]').forEach(a => {
      const h = handleFromHref(a.getAttribute('href'));
      // 멘션 링크(@친구)는 본문이므로 남기고, 작성자 핸들 링크는 제거
      if (h && authorHandle && h.toLowerCase() === authorHandle.toLowerCase()) a.remove();
    });
    let text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    // UI 잡음 제거 — 위에서 time/button/[role=button]을 이미 제거했으므로 보통 깨끗하다.
    // 폴백: 버튼이 아닌 span으로 렌더된 액션 라벨이 본문 "끝"에 붙는 경우만 보수적으로 제거.
    // ⚠️ 단어 하나짜리("좋아요"/"Like")는 실제 댓글 내용일 수 있어 제외 — 다어절 라벨만.
    const trailingNoise = ['답글 달기', '번역 보기', '번역 보기', 'See translation', 'Hide translation'];
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of trailingNoise) {
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('(?:^|\\s)' + esc + '\\s*$');
        if (re.test(text)) { text = text.replace(re, '').trim(); changed = true; }
      }
    }
    // ⚠️ (구) 작성자 핸들 prefix를 startsWith로 잘라내던 fallback은 제거했다.
    //   위에서 작성자 핸들 링크 DOM을 이미 remove()하므로 prefix가 본문에 남지 않고,
    //   문자열 자르기는 댓글이 우연히 핸들로 시작하면 실제 내용을 손상시켜 오탐이었다.
    text = text.replace(/\s+/g, ' ').trim();

    // A6: 본문이 비었으면 움짤/GIF 댓글일 수 있다 — 버리지 말고 "움짤"로 기록.
    //   추첨 이벤트에서 움짤 댓글 누락은 치명적. 프로필 사진(/t51..-19/, profile_pic)은 제외.
    if (!text && liHasGif(li)) return '움짤';
    return text;
  }

  /** A6: li 안에 (프로필 사진이 아닌) 움짤/GIF 이미지가 있는지. */
  function liHasGif(li) {
    try {
      for (const img of li.querySelectorAll('img[src]')) {
        const src = img.getAttribute('src') || '';
        if (!src) continue;
        if (PROFILE_PIC_RE.test(src)) continue;       // 프로필 사진 제외
        if (GIF_SRC_RE.test(src)) return true;
      }
    } catch (e) { /* 무시 */ }
    return false;
  }

  /** 댓글 li에서 작성자 핸들 추출. */
  function extractHandle(li) {
    for (const a of li.querySelectorAll('a[href^="/"]')) {
      const h = handleFromHref(a.getAttribute('href'));
      if (h) return h;
    }
    return '';
  }

  /** 댓글 li에서 작성시간(ISO 우선, 없으면 표시문자열) + 링크 추출. */
  function extractTimeAndLink(li) {
    let timeText = '';
    let link = '';
    const t = li.querySelector('time[datetime]') || li.querySelector('time');
    if (t) {
      timeText = t.getAttribute('datetime') || (t.textContent || '').trim();
      // 시간 요소를 감싼 댓글 permalink(a[href*="/c/"] 또는 /p/.../c/...)
      const a = t.closest('a[href]');
      if (a) link = absUrl(a.getAttribute('href'));
    }
    if (!link) {
      // 댓글 permalink 폴백: li 내 /c/ 포함 링크 → 없으면 게시물 URL
      const cLink = Array.from(li.querySelectorAll('a[href]'))
        .map(a => a.getAttribute('href'))
        .find(h => h && h.includes('/c/'));
      link = cLink ? absUrl(cLink) : cleanPostUrl(location.href);
    }
    return { timeText, link };
  }

  function absUrl(href) {
    if (!href) return '';
    try { return new URL(href, location.origin).href; } catch (e) { return href; }
  }

  /** 게시물 URL 정규화(쿼리 제거). */
  function cleanPostUrl(href) {
    try {
      const u = new URL(href, location.origin);
      return u.origin + u.pathname;
    } catch (e) { return href; }
  }

  /** 멘션 여부(텍스트 신호): 본문에 @핸들 패턴이 있으면 true. */
  const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9._]{2,})/;
  function hasMentionText(text) {
    return MENTION_RE.test(text || '');
  }

  /**
   * 멘션 여부(방어적·두 신호 OR). 실제 인스타 DOM 미검증이라 둘 다 커버한다.
   *  (a) 텍스트 신호: 본문에 `@핸들` 패턴.
   *  (b) DOM 신호: 인스타 멘션은 `<a href="/친구/">친구</a>`로 렌더돼 표시 텍스트에
   *      `@`가 없을 수 있다 → 본문 영역에 "작성자 핸들 링크를 제외한" 프로필 링크
   *      (`a[href^="/"]`가 핸들 형태)가 남아 있으면 멘션으로 본다.
   *  둘 중 하나라도 true면 멘션. authorHandle = 이 댓글 작성자(본인 링크는 제외).
   * @param {Element} li 댓글 노드
   * @param {string} authorHandle 이 댓글 작성자 핸들(본인 헤더 링크 제외용)
   * @param {string} text 이미 추출된 본문(텍스트 신호용)
   */
  function detectMention(li, authorHandle, text) {
    if (hasMentionText(text)) return true; // (a) 텍스트 신호
    // (b) DOM 신호: 본문 내 프로필 링크 잔존(작성자 본인 링크는 멘션 아님)
    try {
      const author = (authorHandle || '').toLowerCase();
      for (const a of li.querySelectorAll('a[href^="/"]')) {
        const h = handleFromHref(a.getAttribute('href'));
        if (!h) continue;                       // /p/, /explore/ 등 비-핸들 경로 제외
        if (author && h.toLowerCase() === author) continue; // 작성자 본인 링크 제외
        return true;                            // 그 외 프로필 링크 = 멘션 대상
      }
    } catch (e) { /* 무시 — 텍스트 신호로만 판단 */ }
    return false;
  }

  /**
   * A5: 답글 펼침 버튼 클릭 (대댓글 수집 옵션 ON).
   *  - el.click() 단발 대신 syntheticClick(합성 이벤트 시퀀스) 사용.
   *  - 식별을 textContent + aria-label 둘 다 검사로 확장(인스타 답글버튼은
   *    표시 텍스트 없이 aria-label만 있는 경우가 있다).
   *  - 댓글 많을 때(>임계) 클릭 간 딜레이를 늘리는 적응형 감속.
   *  - 이미 클릭한 버튼 hkExpanded 스킵 유지.
   * @param {Element|null} scope 검색 범위
   * @param {number} collectedCount 현재까지 수집 댓글 수(적응형 감속용)
   */
  async function expandReplies(scope, collectedCount) {
    const root = scope || document.querySelector('article') || document.body;
    const clickables = root.querySelectorAll('button, [role="button"], div[role="button"], span[role="button"]');
    // 적응형 감속: 댓글 많으면 클릭 간 딜레이를 길게(차단 회피 + 안정).
    const clickDelay = (collectedCount > HEAVY_COMMENT_THRESHOLD) ? 900 : 450;
    let clicked = 0;
    for (const el of clickables) {
      // 이미 클릭한 펼침 버튼은 스킵 — 매 라운드 같은 버튼 재클릭 방지(종료 지연 완화).
      if (el.dataset && el.dataset.hkExpanded === '1') continue;
      const label = buttonLabel(el); // textContent + aria-label 합본(소문자)
      if (!label) continue;
      // ⚠️ "답글 달기"(답글 입력창)·숨기기·reply 류는 절대 클릭 금지 — REPLY_DENY로 명시 제외.
      //    실측(CDP): 펼침은 <button>"답글 보기(N개)", 입력은 <button>"답글 달기". 단독 '답글' 매칭 제거됨.
      if (REPLY_DENY_TEXTS.some(d => label.includes(d.toLowerCase()))) continue;
      if (HIDE_BUTTON_TEXTS.some(h => label.includes(h))) continue;
      // load-more 버튼은 clickLoadMore가 처리 — 여기선 답글 펼침 버튼만.
      if (LOADMORE_BUTTON_TEXTS.some(t => label.includes(t.toLowerCase()))) continue;
      if (REPLY_BUTTON_TEXTS.some(r => label.includes(r.toLowerCase()))) {
        // "답글 보기(N개)" 부분매칭 — 변형 커버. 입력/숨기기는 위에서 이미 배제됨.
        try {
          // 클릭 대상이 div/span 래퍼면 내부 클릭 가능한 span도 함께 시도.
          el.scrollIntoView({ block: 'center' });
          syntheticClick(el);
          if (el.dataset) el.dataset.hkExpanded = '1';
          clicked++;
          await sleep(clickDelay);
        } catch (e) { /* 무시 */ }
      }
    }
    return clicked;
  }

  /**
   * 재추출 대비 stale 마킹 초기화.
   * hkSeen/hkExpanded/hkLoadmore는 인스타 실제 DOM 노드에 박는다. 페이지 리로드 없이
   * (retry·done 후 재시작 등) 같은 게시물에서 다시 추출하면 이전 마킹이 남아
   * findCommentNodes가 모든 댓글을 hkSeen으로 건너뛰어 0건 수집("댓글 못 찾음")이 된다.
   * 매 수집 시작 시 우리 마킹만 제거한다(인스타 DOM은 그대로).
   */
  function resetSeenMarks() {
    try {
      for (const el of document.querySelectorAll('[data-hk-seen],[data-hk-expanded],[data-hk-loadmore]')) {
        if (!el.dataset) continue;
        delete el.dataset.hkSeen;
        delete el.dataset.hkExpanded;
        delete el.dataset.hkLoadmore;
      }
    } catch (e) { /* 무시 — 마킹 초기화 실패해도 수집은 진행(최악 재추출만 영향) */ }
  }

  /** 추출 시작 — 메인 수집 루프. */
  async function startCollection() {
    if (state.collecting) { setView('progress'); return; }
    state.collecting = true;
    state.cancelRequested = false;
    state.lastResult = null;
    state.lastWorkbook = null;
    resetSeenMarks(); // 재추출 시 이전 라운드의 stale DOM 마킹 제거(0건 수집 버그 방지)

    const sourceUrl = cleanPostUrl(location.href);
    const opts = { ...state.options };

    setView('progress');
    renderProgress(0);
    showScrim();      // B3: 유저 입력 차단 (엔진 스크롤엔 영향 없음)
    setFabBusy(true); // FAB 펄스 정지(작업 중)

    // background에 잡 시작 보고 (single-writer: storage는 background가 씀)
    // ⚠️ ack를 await: 레코드가 running으로 생성된 뒤에야 progress를 보내야
    //    background에서 progress가 버려지지 않는다(메시지 순서 보장).
    await reportAndWait({ type: 'job.start', options: opts, sourceUrl });

    const authorHandle = opts.excludeAuthor ? detectAuthorHandle() : '';

    // dedupe 키: 핸들|내용|시간
    const seen = new Set();
    const collected = []; // { handle, text, timeText, link, isMention }

    // A1: 컨테이너는 보조용(있으면 같이 스크롤). 1차 스크롤은 window/스피너.
    const container = findScrollContainer(); // null 가능 — 더는 스크롤 1차가 아님

    // A3: 종료 판정 분리 — empty(0개 라운드)와 stale(정체 라운드)를 별개로 카운트.
    let emptyRounds = 0;
    let staleRounds = 0;
    let scrolls = 0;
    let lastCount = 0;
    let lastAnchorNode = null; // A1: 마지막 댓글 노드(정체 라운드에도 앵커 유지용)

    try {
      while (!state.cancelRequested && scrolls < MAX_SCROLLS) {
        // (1) 대댓글 옵션 ON이면 보이는 답글 펼침 버튼 클릭 (A5: 합성클릭+적응형 감속)
        if (opts.includeReplies) {
          await expandReplies(container, collected.length);
        }

        // (2) A2: 상위 댓글 "댓글 더 읽어들이기" load-more 버튼 클릭 — 핵심 로딩 메커니즘.
        clickLoadMore(container);

        // (3) 현재 보이는 댓글 추출 (A4 폴백체인 사용)
        const nodes = findCommentNodes(container);
        if (nodes.length) lastAnchorNode = nodes[nodes.length - 1];
        for (const li of nodes) {
          const handle = extractHandle(li);
          if (!handle) continue;
          const text = extractCommentText(li, handle); // A6: 움짤이면 "움짤" 반환
          if (!text) continue;
          const { timeText, link } = extractTimeAndLink(li);
          const key = handle + '|' + text + '|' + timeText;
          if (seen.has(key)) continue;
          seen.add(key);

          // 작성자 제외 옵션
          if (opts.excludeAuthor && authorHandle && handle.toLowerCase() === authorHandle.toLowerCase()) {
            continue;
          }
          collected.push({ handle, text, timeText, link, isMention: detectMention(li, handle, text) });
        }

        // (4) 진행률 갱신 (UI 직접 + background 기록)
        const done = collected.length;
        renderProgress(done);
        if (done !== lastCount) {
          reportToBackground({ type: 'job.progress', done, total: done });
        }

        // (5) 종료 판정 — "더보기 버튼 없음 + 새 댓글 안 늚 + 스피너 없음"일 때만 종료.
        //   실측(CDP): 게시물 페이지엔 로딩 스피너가 없고(대부분), 로딩은 window 스크롤 +
        //   "댓글 더 읽어들이기" 클릭으로 일어난다. 그래서:
        //   - 더보기 버튼이 남아 있는 한 절대 종료하지 않는다(다 누르면 버튼이 사라짐).
        //   - 스피너가 떠 있으면 로딩 중이므로 관대(EMPTY_ROUNDS_LIMIT).
        //   - 둘 다 없고 신규 0개면 바닥 도달 → 빠르게 종료(NO_SPINNER_EMPTY_LIMIT).
        const spinnerVisible = !!document.querySelector(LOADING_SPINNER_SEL);
        const loadMorePresent = hasLoadMoreButton(container);
        if (done > lastCount) {
          // 새 댓글이 늘었다 — 정상 진행. 카운터 리셋.
          emptyRounds = 0;
          staleRounds = 0;
        } else if (loadMorePresent || spinnerVisible) {
          // 아직 불러올 게 남았다(버튼/스피너) — 종료하지 않고 관대하게 대기.
          //   더보기 버튼은 클릭 직후 새로 로드되기 전 잠깐 정체될 수 있으므로 종료 금지.
          emptyRounds++;
          staleRounds++;
          if (emptyRounds >= EMPTY_ROUNDS_LIMIT) break; // 안전상한(무한 로딩 방지)
        } else if (nodes.length === 0) {
          // 더보기 없음 + 스피너 없음 + 노드 0개 = 바닥 → 빠르게 종료.
          emptyRounds++;
          if (emptyRounds >= NO_SPINNER_EMPTY_LIMIT) break;
        } else {
          // 더보기 없음 + 스피너 없음 + 노드는 있으나 정체(dedupe/끝물).
          staleRounds++;
          if (staleRounds >= STALE_ROUNDS_LIMIT) break;
        }
        lastCount = done;

        // (6) A1: 스크롤 앵커 — 스피너 추적 1차 → 마지막 댓글 노드 → window.scrollBy.
        //   컨테이너가 있으면 보조로 같이 내린다(1차는 window/스피너).
        const anchorNodes = lastAnchorNode ? [lastAnchorNode] : [];
        scrollStep(anchorNodes, container);
        scrolls++;
        await sleep(ROUND_DELAY_MS);
      }

      // ── 결과 빌드 ──
      const result = buildResult(collected, opts);

      if (state.cancelRequested) {
        // 중지하고 지금까지 저장
        finishCollection(result, opts, sourceUrl, /*canceled=*/true);
        reportToBackground({ type: 'job.canceled', done: result.total });
      } else if (result.total === 0) {
        state.collecting = false;
        showError('댓글을 찾지 못했습니다. 게시물을 열고 댓글 영역이 보이게 한 뒤 다시 시도하세요.');
        reportToBackground({ type: 'job.error', code: 'UNKNOWN', message: '댓글을 찾지 못함' });
      } else {
        finishCollection(result, opts, sourceUrl, /*canceled=*/false);
        reportToBackground({ type: 'job.done', total: result.total });
      }
    } catch (e) {
      state.collecting = false;
      showError('추출 중 오류가 발생했어요: ' + ((e && e.message) || String(e)));
      reportToBackground({ type: 'job.error', code: 'UNKNOWN', message: (e && e.message) || String(e) });
    } finally {
      // B3: 완료/중지/에러 어떤 경로로 끝나도 스크림 제거 + FAB 펄스 복원.
      hideScrim();
      setFabBusy(false);
    }
  }

  /**
   * dedupe된 collected → 최종 레코드 배열.
   * 멘션 2배 가중: dedupe 후 멘션 댓글을 한 줄 더 추가(중복 가중).
   */
  function buildResult(collected, opts) {
    // collected는 이미 (handle|text|time)로 dedupe된 상태
    let records = collected.slice();

    let mentionWeighted = 0;
    if (opts.weightMention) {
      const extra = [];
      for (const r of collected) {
        if (r.isMention) {
          extra.push({ ...r });
          mentionWeighted++;
        }
      }
      records = records.concat(extra);
    } else {
      mentionWeighted = collected.filter(r => r.isMention).length;
    }

    const uniqueAccounts = new Set(collected.map(r => r.handle.toLowerCase())).size;

    return {
      records,                 // 엑셀에 들어갈 행 (멘션 2배 적용됨)
      total: records.length,   // 가중 포함 총 건수
      uniqueAccounts,
      mentionWeighted,         // 멘션으로 한 줄 더 추가된 수 (또는 멘션 댓글 수)
    };
  }

  /** 수집 종료 처리 — 엑셀 생성 + done 화면. */
  function finishCollection(result, opts, sourceUrl, canceled) {
    state.collecting = false;
    state.cancelRequested = false;
    state.lastResult = result;

    const { workbook, fileName } = buildWorkbook(result, opts, sourceUrl);
    state.lastWorkbook = workbook;
    state.lastFileName = fileName;

    renderDone(result, fileName);
    if (canceled) {
      bind('doneTitle').textContent = '여기까지 저장했어요';
      bind('doneSub').textContent = '중간 저장';
    }
    setView('done');
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 5. 엑셀 출력 (SheetJS) — docs/features/엑셀-출력-표준.md 표준
  // ────────────────────────────────────────────────────────────────────────────
  const ACCENT_HEX = '1B3A6B';

  /** KST 기준 날짜/시각 문자열. */
  function kstParts() {
    // UTC+9 고정 (KST는 DST 없음)
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 3600 * 1000);
    const y = kst.getUTCFullYear();
    const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
    const d = String(kst.getUTCDate()).padStart(2, '0');
    const hh = String(kst.getUTCHours()).padStart(2, '0');
    const mm = String(kst.getUTCMinutes()).padStart(2, '0');
    return { date: `${y}-${mo}-${d}`, time: `${hh}:${mm}`, hhmm: `${hh}${mm}` };
  }

  /**
   * A7: time[datetime](ISO/UTC)을 KST "YYYY-MM-DD HH:MM:SS"로 변환.
   * ISO로 파싱 안 되면(상대시간 표시 텍스트 등) 원문 그대로 폴백.
   */
  function formatKstTime(timeText) {
    if (!timeText) return '';
    const d = new Date(timeText);
    if (isNaN(d.getTime())) return timeText; // 파싱 실패 → 표시 문자열 폴백
    const kst = new Date(d.getTime() + 9 * 3600 * 1000);
    const y = kst.getUTCFullYear();
    const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
    const da = String(kst.getUTCDate()).padStart(2, '0');
    const hh = String(kst.getUTCHours()).padStart(2, '0');
    const mm = String(kst.getUTCMinutes()).padStart(2, '0');
    const ss = String(kst.getUTCSeconds()).padStart(2, '0');
    return `${y}-${mo}-${da} ${hh}:${mm}:${ss}`;
  }

  function optionsLabel(opts) {
    return [
      '작성자 제외=' + (opts.excludeAuthor ? 'ON' : 'OFF'),
      '멘션 2배=' + (opts.weightMention ? 'ON' : 'OFF'),
      '대댓글=' + (opts.includeReplies ? 'ON' : 'OFF'),
    ].join(', ');
  }

  /** 결과 → SheetJS workbook + 파일명. */
  function buildWorkbook(result, opts, sourceUrl) {
    const XLSX = window.XLSX;
    const k = kstParts();

    // ── "데이터" 시트 ──
    // 컬럼 순서: 번호 · 아이디 · 계정링크 · 댓글내용 · 작성시간 · 멘션여부 · 댓글링크
    //   계정링크 = 프로필 URL(https://www.instagram.com/<아이디>) — 추후 DM 자동화 대상.
    //   댓글링크 = 댓글 퍼머링크(/c/...).
    const header = ['번호', '아이디', '계정링크', '댓글내용', '작성시간', '멘션여부', '댓글링크'];
    // 아이디(핸들)는 handleFromHref에서 [A-Za-z0-9._]만 통과(저장 시 @/슬래시 없음) → 그대로 사용.
    const profileUrl = (h) => (h ? `https://www.instagram.com/${h}` : '');
    const aoa = [header];
    result.records.forEach((r, i) => {
      aoa.push([
        i + 1,
        r.handle || '',
        profileUrl(r.handle),            // 계정링크 (핸들 없으면 빈칸)
        r.text || '',
        formatKstTime(r.timeText) || '', // A7: KST 사람읽기 포맷
        r.isMention ? 'Y' : '',
        r.link || '',                    // 댓글링크 (퍼머링크)
      ]);
    });
    const wsData = XLSX.utils.aoa_to_sheet(aoa);

    // ★ "계정링크"·"댓글링크" 컬럼을 클릭 가능한 하이퍼링크로.
    //   SheetJS 커뮤니티 빌드(xlsx.full.min.js)는 셀 객체에 `.l = { Target, Tooltip }`을
    //   부여하면 .xlsx 직렬화 시 <hyperlinks>로 기록된다(엑셀에서 클릭→브라우저로 열림).
    //   셀이 sheet 범위(!ref)에 포함되도록 aoa_to_sheet가 만든 기존 셀 객체에 .l만 덧붙인다.
    const ACCOUNT_LINK_COL = header.indexOf('계정링크');
    const COMMENT_LINK_COL = header.indexOf('댓글링크');
    result.records.forEach((r, i) => {
      // 계정링크 — 핸들 있을 때만 하이퍼링크(없으면 빈 셀 유지)
      const accUrl = profileUrl(r.handle);
      if (ACCOUNT_LINK_COL >= 0 && accUrl) {
        const addr = XLSX.utils.encode_cell({ r: i + 1, c: ACCOUNT_LINK_COL }); // +1: 헤더행 다음
        const cell = wsData[addr];
        if (cell) cell.l = { Target: accUrl, Tooltip: '이 계정 프로필 열기 (DM 자동화용)' };
      }
      // 댓글링크 — 퍼머링크 있을 때만 하이퍼링크
      const cmtUrl = r.link || '';
      if (COMMENT_LINK_COL >= 0 && cmtUrl) {
        const addr = XLSX.utils.encode_cell({ r: i + 1, c: COMMENT_LINK_COL });
        const cell = wsData[addr];
        if (cell) cell.l = { Target: cmtUrl, Tooltip: '브라우저에서 이 댓글/게시물 열기' };
      }
    });

    // 열 너비 (긴 텍스트 컬럼은 60자 캡) — header 순서와 1:1 대응
    wsData['!cols'] = [
      { wch: 6 },   // 번호
      { wch: 20 },  // 아이디
      { wch: 36 },  // 계정링크
      { wch: 60 },  // 댓글내용
      { wch: 22 },  // 작성시간
      { wch: 9 },   // 멘션여부
      { wch: 40 },  // 댓글링크
    ];
    // 1행 고정
    wsData['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' };
    wsData['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: header.length - 1 } }) };
    // 1행 높이
    wsData['!rows'] = [{ hpt: 22 }];

    // 헤더 스타일 (community 빌드 한도 내 best-effort — 적용 안 돼도 데이터는 정상)
    for (let c = 0; c < header.length; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      const cell = wsData[addr];
      if (cell) {
        cell.s = {
          fill: { patternType: 'solid', fgColor: { rgb: ACCENT_HEX } },
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          alignment: { horizontal: 'center', vertical: 'center' },
        };
      }
    }

    // ── "정보" 시트 ──
    const info = [
      ['툴', '인스타 댓글 스카우트 (insta-comment)'],
      ['버전', TOOL_VERSION],
      ['추출 일시', `${k.date} ${k.time} (KST)`],
      ['원본 URL', sourceUrl || cleanPostUrl(location.href)],
      ['총 건수', result.total],
      ['고유 계정', result.uniqueAccounts],
      ['옵션', optionsLabel(opts)],
    ];
    const wsInfo = XLSX.utils.aoa_to_sheet(info);
    wsInfo['!cols'] = [{ wch: 14 }, { wch: 60 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsData, '데이터');
    XLSX.utils.book_append_sheet(wb, wsInfo, '정보');

    const fileName = `insta-comment_${k.date}.xlsx`;
    return { workbook: wb, fileName };
  }

  /** 다운로드 버튼 — 이미 만든 workbook을 그대로 저장(파일명 충돌 시 _HHmm). */
  function downloadExcel() {
    if (!state.lastWorkbook) return;
    const XLSX = window.XLSX;
    try {
      XLSX.writeFile(state.lastWorkbook, state.lastFileName);
    } catch (e) {
      // 같은 날 재다운로드 등으로 실패하면 _HHmm 붙여 재시도
      try {
        const k = kstParts();
        const alt = state.lastFileName.replace(/\.xlsx$/, `_${k.hhmm}.xlsx`);
        XLSX.writeFile(state.lastWorkbook, alt);
      } catch (e2) {
        showError('엑셀 저장에 실패했어요: ' + ((e2 && e2.message) || String(e2)));
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 6. SPA 라우팅 — 게시물/릴 페이지에서만 FAB 표시
  // ────────────────────────────────────────────────────────────────────────────
  // 인스타 게시물/릴 경로: /p/<id>/, /reel/<id>/, /<user>/p/<id>/, /<user>/reel/<id>/
  const POST_PATH_RE = /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels)\/[^/]+/;

  function isPostPage() {
    return POST_PATH_RE.test(location.pathname);
  }

  function updateFabVisibility() {
    if (!shadowRoot) return;
    const root = $('.root');
    if (!root) return;
    const show = isPostPage();
    root.style.display = show ? '' : 'none';
    // 게시물을 벗어나면 진행 중이 아닌 한 FAB로 리셋
    if (!show && !state.collecting) {
      // 결과/옵션 패널 열려있던 것 접기
      if (state.view !== 'fab') setView('fab');
    }
  }

  /** history pushState/replaceState 패치 + popstate + 주기적 폴링으로 URL 변경 감지. */
  function watchUrlChanges() {
    const fire = () => {
      // 다른 게시물로 이동 시 직전 결과는 더 이상 유효하지 않으니 정리(진행 중이 아니면)
      if (!state.collecting) {
        // URL이 실제로 바뀐 경우에만 초기화
      }
      updateFabVisibility();
    };
    const wrap = (orig) => function () {
      const ret = orig.apply(this, arguments);
      setTimeout(fire, 50);
      return ret;
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', () => setTimeout(fire, 50));

    // 폴백 폴링 (pushState 패치가 SPA 내부 라우터에 안 잡힐 때 대비)
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        // 게시물이 바뀌면 이전 결과는 초기화(진행 중이 아닐 때만)
        if (!state.collecting) {
          state.lastResult = null;
          state.lastWorkbook = null;
        }
        fire();
      }
    }, 1000);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 7. 부트스트랩
  // ────────────────────────────────────────────────────────────────────────────
  function boot() {
    mountUI();
    watchUrlChanges();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
