// 팝업은 안내 전용 — 추출 트리거는 페이지에 주입된 플로팅 버튼(content.js)이 담당.
// (transport = chrome.storage + chrome.runtime 메시지, single-writer)
document.getElementById("openInsta").addEventListener("click", function (e) {
  e.preventDefault();
  chrome.tabs.create({ url: "https://www.instagram.com/" });
});
