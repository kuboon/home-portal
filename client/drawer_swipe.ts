/**
 * チャット領域の横スワイプで daisyUI の drawer（スレッドメニュー）を開閉する。
 *
 * 畳まれているときはチャット領域のどこを右スワイプしても左から引き出し、
 * 開いているときは左スワイプで閉じる。DOM だけに依存し、フレームワークには
 * 依存しないので単体で検証できる。
 */

/** スワイプ起点の分類。 */
export type SwipeOrigin =
  /** チャット領域（drawer-content）。ここからは開閉どちらもできる。 */
  | "content"
  /** サイドバーやオーバーレイ。閉じるのは許す。 */
  | "outside"
  /** 入力欄や横スクロールできる要素の中。スワイプとして扱わない。 */
  | "skip";

/**
 * 起点の要素から祖先を辿って分類する。入力欄はカーソル操作、横スクロール
 * できる要素はその要素を動かす操作なので、どちらも drawer には回さない。
 */
export function swipeOrigin(target: EventTarget | null): SwipeOrigin {
  let el = target instanceof Element ? target : null;
  for (; el; el = el.parentElement) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return "skip";
    if (el instanceof HTMLElement && el.isContentEditable) return "skip";
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return "skip";
    }
    if (el.classList.contains("drawer-content")) return "content";
  }
  return "outside";
}

export interface DrawerSwipeOptions {
  /** drawer-toggle チェックボックスの id。 */
  drawerId: string;
  /** 開く操作。開けない場面（デスクトップ）では何もしない実装を渡す。 */
  open: () => void;
  /** 閉じる操作。 */
  close: () => void;
  /** 反応する横移動量(px)。既定 60。 */
  minDx?: number;
  /** これを超える縦移動はスクロール扱い。既定 50。 */
  maxDy?: number;
  /** リスナを付ける先。既定は document。 */
  target?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}

/** スワイプ検出を仕掛ける。戻り値を呼ぶと解除する。 */
export function installDrawerSwipe(opts: DrawerSwipeOptions): () => void {
  const { drawerId, open, close } = opts;
  const minDx = opts.minDx ?? 60;
  const maxDy = opts.maxDy ?? 50;
  const target = opts.target ?? document;

  let sx = 0;
  let sy = 0;
  let origin: SwipeOrigin = "skip";

  const onStart = (ev: Event) => {
    const e = ev as TouchEvent;
    // ピンチなどのマルチタッチはスワイプではない。
    if (e.touches.length !== 1) {
      origin = "skip";
      return;
    }
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    origin = swipeOrigin(e.target);
  };

  const onEnd = (ev: Event) => {
    if (origin === "skip") return;
    const e = ev as TouchEvent;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    // 横方向がはっきり勝っているときだけスワイプとみなす。
    if (Math.abs(dy) > maxDy || Math.abs(dx) <= Math.abs(dy)) return;
    const cb = document.getElementById(drawerId) as HTMLInputElement | null;
    if (!cb) return;
    if (!cb.checked && dx > minDx && origin === "content") open();
    else if (cb.checked && dx < -minDx) close();
  };

  target.addEventListener("touchstart", onStart, { passive: true });
  target.addEventListener("touchend", onEnd, { passive: true });
  return () => {
    target.removeEventListener("touchstart", onStart);
    target.removeEventListener("touchend", onEnd);
  };
}
