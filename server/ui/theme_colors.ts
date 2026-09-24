/**
 * ステータスバーへ宣言する背景色。
 *
 * iOS 26 以降、ホーム画面に追加した standalone のウェブアプリでは、ページ
 * 上端の平坦な色を宣言していないと、システムがステータスバー帯に Liquid
 * Glass の「scroll edge effect」を敷く。これがステータスバーより下まで滲み
 * 出して、直下のヘッダーをぼかす。`theme-color` で色を明示すると、システムは
 * それを不透明に塗るだけで済む。
 *
 * 値は daisyUI の `--color-base-100` を sRGB に直したもの。`assets/style.css`
 * の `@plugin "daisyui"` でテーマを足し引きしたら、ここも合わせること。
 */

/** light テーマの base-100。既定のカラースキーム。 */
export const BASE_100_LIGHT = "#ffffff";

/** dark テーマの base-100（`--prefersdark`）。 */
export const BASE_100_DARK = "#1d232a";

/** cupcake の base-100。永続シェルはこのテーマに固定されている。 */
export const BASE_100_CUPCAKE = "#faf7f5";
