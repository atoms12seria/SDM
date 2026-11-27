# Seria Site Management

Cloudflare Workers + D1 + Durable Objects を使った、サイト制作依頼・個人チャットのスターターです。

## 現在の実装範囲

- メールアドレス＋パスワード登録（メール確認必須）
- PBKDF2-SHA-256 によるパスワードハッシュ化
- HttpOnly / Secure / SameSite=Lax セッションCookie
- 利用者ごとの依頼作成・閲覧
- 管理者の依頼一覧・ステータス変更API
- 依頼者と管理者だけがアクセスできるメッセージAPI
- Durable Objects + WebSocket によるチャット通知
- 管理者メールアドレスによる管理者ロール割り当て
- 管理者端末の登録ゲート

## 重要な注意

これは初期開発用スターターです。公開前に、ログイン・登録・メール送信・アクセス制御・WebSocketを実環境でテストしてください。追加で、ログイン試行制限、パスワード再設定、アカウント削除、監査ログ、スパム対策、バックアップ、プライバシーポリシーを実装してください。

ブラウザに保存する端末IDは複製・変更できるため、それ単独を本人確認の根拠にしてはいけません。本構成では管理者メール認証とサーバー側の承認済み端末レコードを併用します。より強い端末認証が必要な場合はWebAuthn/passkey等を追加してください。

## 1. 必要なもの

- Node.js / npm
- GitHubアカウント
- Cloudflareアカウント
- 送信ドメインを認証済みのResendアカウント（メール確認用）
- サイト用ドメイン（任意。Cloudflareで管理すると設定しやすい）

## 2. 初期設定

```bash
npm install
npx wrangler login
```

D1データベースを作成:

```bash
npx wrangler d1 create seria-site-management-db
```

表示された `database_id` を `wrangler.toml` の `REPLACE_WITH_YOUR_D1_DATABASE_ID` と置き換えます。

`wrangler.toml` の次の値を実際のURL・送信元に変更します。

- `APP_ORIGIN`: 公開するサイトのURL（末尾の `/` は不要）
- `EMAIL_FROM`: Resendで認証した送信元アドレス

## 3. 秘密情報を登録

管理者にするメールアドレスを登録します。

```bash
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_DEVICE_ENROLL_CODE
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put INTERNAL_SECRET
```

- `ADMIN_EMAIL`: 管理者アカウントとして使うメールアドレス（小文字）
- `ADMIN_DEVICE_ENROLL_CODE`: 管理者端末を初回登録するための長くランダムなコード
- `RESEND_API_KEY`: Resend APIキー
- `INTERNAL_SECRET`: Durable Objectへの内部通知を保護する長くランダムな秘密値

秘密値はGitHubへコミットしないでください。

## 4. D1マイグレーション

```bash
npx wrangler d1 migrations apply DB --remote
```

## 5. ローカル開発

```bash
npm run dev
```

## 6. デプロイ

```bash
npm run deploy
```

## 7. 初回管理者設定

1. `ADMIN_EMAIL` に指定したメールアドレスで一般登録します。
2. 受信メールのリンクからメールアドレスを確認します。
3. ログインします。
4. 「管理者端末の登録」に端末名と `ADMIN_DEVICE_ENROLL_CODE` を入力します。
5. 登録後、そのブラウザを管理者用端末として使用します。

管理者ロールはサーバー側で `ADMIN_EMAIL` と照合して割り当てます。ブラウザの表示切替だけで管理者にはなれません。

## 8. GitHub連携

このフォルダをGitHubリポジトリへpushし、Cloudflare Workers Buildsでリポジトリを接続するか、ローカルから `npm run deploy` してください。Workers Buildsを使う場合も、秘密情報はCloudflare側のSecretsに登録します。

## 9. メール送信

このスターターはResendのAPIを利用します。Resend側で送信ドメインのDNS認証を済ませ、APIキーをWorker Secretとして登録してください。Cloudflare Email Sendingを使う構成に切り替えることもできます。

## 10. 本番公開前の必須作業

- ログイン・登録・メール送信のレート制限
- パスワード再設定とメール変更フロー
- WebSocket再接続と重複メッセージ対策
- 管理者端末の失効・再登録画面
- 管理者による依頼ステータス変更UI
- D1バックアップとデータ保持方針
- プライバシーポリシーと利用規約
- 脆弱性・権限テスト
