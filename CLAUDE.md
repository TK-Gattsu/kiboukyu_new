# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a standalone single-file HTML app (`希望休申請アプリ.html`) for managing vacation/day-off requests (希望休申請) for a hospital pharmacy department (病院薬剤部). It runs directly in a browser with no server or build step required.

## Development

Open `希望休申請アプリ.html` directly in a browser to run the app. There is no build, lint, or test toolchain.

## Architecture

Everything lives in one file: `希望休申請アプリ.html`. It has three logical sections:

**HTML structure** — Three main panels that are shown/hidden via `display` toggling:
- `#login-panel` — name selection + admin entry
- `#main-panel` — staff calendar view with dynamic tabs (`#staff-tabs` / `#cal-contents`)
- `#admin-panel` — admin view with dynamic tabs (`#admin-tabs` / `#adm-contents`)

Tab contents are rebuilt dynamically by `rebuildStaffPanel()` and `rebuildAdminPanel()` using IDs like `cal${month}` and `adm${month}`, so IDs are not hardcoded in HTML.

**Persistence** — All data is stored in `localStorage` with these keys:
| Key | Contents |
|-----|----------|
| `kiboushu_teams_2026` | Team→members map (JSON) |
| `kiboushu_requests` | `{ staffName: { "YYYY-MM-DD": type } }` (migrates from old key `kiboushu_2026_79`) |
| `kiboushu_period` | `{ year, months: [m1, m2, m3] }` |
| `kiboushu_admin_pw` | Admin password (plaintext) |
| `kiboushu_rules` | Rules text |
| `kiboushu_rule_pdfs` | Array of `{ name, size, date, data }` where `data` is base64 PDF |

**Key functions and their roles:**
- `getPeriod()` / `getYear()` / `getMonths()` — dynamic period (replaces hardcoded `YEAR`/`MONTHS`)
- `rebuildStaffPanel()` / `rebuildAdminPanel()` — rebuild DOM tabs+content when period changes; called at init and on `applyPeriod()`
- `renderAdminTable(m, containerId)` — renders the full staff×day table for month `m`; used by both admin view and the staff "全員の申請" view
- `computeDayCounts(m, data, staff)` — batches day-count calculation to avoid repeated localStorage reads
- `_admRendered` cache object + `invalidateAdminCache()` — lazy rendering for admin month tables; invalidated on any staff/data change
- `isRestDay(m, d)` → `getLimit()` returns `Infinity` for weekends/holidays; modal shows only「×」for those days

**External dependency:** SheetJS `xlsx.full.min.js` v0.18.5 via CDN (for Excel export only).

**Holiday data:** Built-in `HOLIDAYS_BUILTIN` constant covers 2025–2027. No dynamic holiday fetching.

## 勤務表作成アプリ（`勤務表作成アプリ.html`）の作り方ガイド

アプリ内の「📖 作り方」ガイド（`GUIDE_UPDATES` と `guideHtml()`）は、ユーザーが手順を確認する唯一のマニュアル。
作り方（手順・ボタン名・画面・自動割り当てのルール）が変わる改修をしたら、同じコミットで必ず:
- `guideHtml()` の該当説明を書き換える
- `GUIDE_UPDATES` の先頭に `{ date, ver, items }` を追加する（`APP_VERSION` と同じバージョン）。先頭が変わるとボタンに「更新あり」が出る
- 説明文は平易な日本語で、ボタン名は画面の表記どおりに書く

## 統合アプリ（`統合アプリ/`・作成中）

希望休申請アプリと勤務表作成アプリを1つにまとめ、勤務変更の申請・承認と実績の記録を行う多人数向けアプリ。Google Apps Script（GAS）＋スプレッドシートで動く。
- `統合アプリ/コード.gs` — サーバー側。ログイン（ID・パスワード、ハッシュ保存）、セッション（CacheService）、権限（`sysadmin`＝システム管理者／`approver`＝システム管理者が指名する承認者）をすべてここで確認する。画面からは `login()` と `api(token, action, payload)` だけを呼ぶ。操作は `ACTIONS` に `{ role, allowBeforeChange, run }` で追加する。名前が `_` で終わる関数は画面から呼べない
- `統合アプリ/index.html` — 画面側（GASの `index` ファイル）。GASの落とし穴により、正規表現リテラルに引用符を書かない・文字列の中に `//` を書かない
- `統合アプリ/dev/preview.html` ＋ `dev/gas-mock.js` — 開発用。GASのサービスをブラウザで模擬して `コード.gs` と `index.html` を動かす（launch設定 `kinmu-app` で `/統合アプリ/dev/preview.html` を開く）。本番には貼り付けない
- データ: シート `users`・`log`・`requests`（申請1件1行。status は active／cancelled／imported）、`docs`（キー `state`＝勤務表作成アプリの JSON書出と同じ形の `{schedule, settings, memo}`、キー `workflow`＝流れと受付）、`archives`（過去の勤務表）。大きいJSONは `docGet_`/`docPut_` で4万文字ずつ分割保存
- 作成の流れ: `workflow.flow` が `request_first`（希望休が先）か `duty_first`（当番が先）。受付は `rounds_()` が flow と `split`（当番が先のとき「土日祝の×」「平日の希望休」の2回に分けるか）から決める。split はあとから切り替え可能で、受付の状態は受付ごと（rest／weekday／all）に保持
- 受付の状態: 受付前 → 受付中 → 調整中 → 締め切り。受付ごとの受付期間（openFrom〜openTo）と調整期間の終わり（adjustTo）を入れると日本時間の日付で自動的に切り替わる（`statusByDate_`）。手動で切り替えると `workflow.status` に保持され、「日付どおり」で解除
- 申請のきまり（`checkRequest_`）: 受付中・調整中の日だけ／勤務表に何か入っている日は不可／受付中は平日5人を超えても申請でき、超過日（`overDays_`、取り込み前の申請と振休の移動も重ねて数える）に申請している人の画面とメニューに注意を出す（ほかの申請者は名前だけ見せ、種類は見せない）／調整中は、調整期間に入った時点の当該者（`workflow.involved`）だけが変更でき、新しく休みを入れるのは5人未満の日だけ／当番が先では「振◆」の代わりに日付つき振休の移動。システム管理者は代理入力と勤務表との重なりを超えた入力（force）ができる
- 勤務表の作成: 統合アプリの「勤務表の作成」は、GitHub Pages の `勤務表作成アプリ.html?embed=1` を iframe で開く（開発時は `KINMU_APP_URL_OVERRIDE` で手元のファイル）。やりとりは postMessage（親→子: `kinmu-load`／`kinmu-flush`／`kinmu-publish-request`、子→親: `kinmu-ready`／`kinmu-loaded`／`kinmu-save`／`kinmu-publish`）。子は `kinmu-load` を受け取るまで送り返さない。保存は `stateSave` で、`state.rev`（`saveState_` が保存のたびに上げる版）が読み込み時と違えば【更新の衝突】として拒否し、親が最新を読み直す。勤務表作成アプリ側の改修は push すれば統合アプリにも反映される（GASへの貼り直し不要）
- 確定・配布: 子の `buildPublishPayload()`（期間・チーム・期間内の勤務・事務連絡・祝日・日直班・長期休暇）を `scheduleConfirm` で `docs` の `confirmed` に保存し、版ごとに `archives` にも残す。スタッフは `scheduleView` で見る
- 勤務変更（`changes` シート）: 種類は swap（交代＝自分が渡す勤務 myDate と相手から引き受ける勤務 partnerDate を同時に入れ替え。対象は日直・夜勤・残り当番で、入は翌日の明も一緒。受け取る側はその日が空いていること）／furi（振休の交換＝2人の日付つき振休の日を入れ替え。振休を動かせるのはこれだけ）／self（自分の勤務の変更＝勤務・有・夏・特・業・出・研・× の間で変更）。状態は wait_partner → wait_approver → approved（または rejected／withdrawn）。承認者は自分が関わる変更を承認できない（システム管理者は可）。同じマスに承認待ちがあれば新しい申請は不可。承認時に申請時のマス（before）と実績が違えば反映しない
- 時間休（kind `hourly`、第4段階）: 遅く来る・早く帰るだけ。勤務表のマスに「有12-17」（12時から17時まで休み）の形で入れ、勤務の日として扱い休み人数には数えない。平日の空きマス（または既存の時間休）だけ。時刻の候補は `hourlyOptions_()` が設定（docs キー `hourly`＝始業・終業・休憩・1日分の時間数・上限日数・年度の始まりの月、既定 8:30〜17:15・休憩12:00〜13:00・5日×8時間・4月）から作る。時間数は休憩を除いて1時間単位で切り上げ、申請時の値を cells の `beforeHours`/`afterHours` に記録。年度の上限は承認済み＋申請中の増減の合計（`hourlyUsed_`）で確認。時間休のある日は交代不可、自分の勤務の変更で「有」などに変えられる。設定は「期間・流れ・受付の設定」の「時間休の設定」
- 条件外（`deviations_`、変更で新しく起きるものだけ）: 平日の休み5人超え／7日以上の連続勤務／夜勤明けの翌日の勤務／振休の付与期限（前回繰越は対象外）。条件外は理由5文字以上が必須。理由は `publicChange_` でシステム管理者・承認者・申請者本人にだけ返す
- 実績: `actual_()` が確定版に、確定後（appliedAt > confirmedAt）に承認された変更を順に重ねる。承認時に `applyToState_` で勤務表作成アプリのデータ（state）にも反映し、振休の自動配置記録（furi_auto）も付け替える
- ログアウト時は `resetViews()` で全画面を初期の中身に戻し、読み込んだデータも消す（次の人に前の人の内容を見せない）
- 進め方: 第1段階＝基盤（ログイン・権限・スタッフ管理・操作記録）／第2段階＝希望休申請と勤務表作成の統合・確定配布／第3段階＝勤務変更（交代は依頼者→受領者→承認者、追加は申請者→承認者、振休は振休同士のみ、条件逸脱は理由必須でシステム管理者と承認者だけが閲覧）／第4段階＝時間休（遅く来る・早く帰る、1時間単位、「有12-17」表示）／第5段階＝実績の集計・分析

## Domain Context

- Staff are organized into teams (A–E + その他 + 事務); default members are in `DEFAULT_TEAMS`
- Request types: `特`, `夏`, `有`, `振`, `振◆`, `×`
- Weekdays: max 5 people per day; weekends/holidays: `×` only, no limit
- The period is 3 arbitrary months selected by admin (default: July–September 2026)
- Japanese public holidays for 2026 include 国民の休日 (sandwich holiday) on 9/22
