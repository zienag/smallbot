# smallbot — телеграм-канал с релизами Claude Code

Cloudflare Worker с cron-триггером: следит за релизами Claude Code, делает LLM-резюме и постит в телеграм-канал. Серверлесс, без VPS.

## Проверенные факты об источниках (2026-07-18)

- `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` — публичный, без токена. Формат: заголовки `## X.Y.Z` + маркированные буллеты, свежие сверху, дат нет.
- npm registry: `https://registry.npmjs.org/@anthropic-ai/claude-code/latest` (маленький ответ) → поле `version` = dist-tag `latest`. В npm бывают версии БЕЗ записи в changelog (dist-tag `next` опережает). Поэтому **источник правды — changelog**, npm только как guard «версия реально отрелизилась» (постим только версии ≤ npm latest).
- Крупные релизы (напр. 2.1.212) — 50+ буллетов, полные ноты НЕ влезают в лимит Telegram-сообщения (4096 символов). Якорь на версию: `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21212` (точки убираются).

## Структура проекта

```
wrangler.jsonc          # cron "*/15 * * * *", KV binding RELEASES, vars
package.json            # typescript, wrangler, @anthropic-ai/sdk, vitest
tsconfig.json
src/
  index.ts              # scheduled-хендлер (пайплайн) + fetch-хендлер (ручной триггер)
  changelog.ts          # fetch + парсинг `## X.Y.Z` → [{version, notes}]
  npm.ts                # получение npm latest
  summarize.ts          # Claude API: резюме + вердикт
  telegram.ts           # сборка поста + sendMessage (HTML parse mode)
  version.ts            # semver-компаратор (~10 строк, без зависимостей)
test/changelog.test.ts  # парсер на сохранённом реальном фрагменте changelog
```

## Пайплайн (каждый cron-тик)

1. Fetch changelog, распарсить версии.
2. `lastPosted` из KV (ключ `last_posted_version`).
3. Кандидаты: `> lastPosted` (semver) и `<= npm latest`.
4. Постить в хронологическом порядке, максимум 5 за прогон.
5. На версию: резюме → пост → **только после успешного поста** записать версию в KV. Ошибка на любом шаге — прервать цикл (следующий тик продолжит с того же места). Это даёт идемпотентность и догон после простоя.
6. Первый запуск (KV пуст): запостить только самую свежую версию, исторические не постить.

## Резюме через Claude API

- Модель `claude-opus-4-8` (решение владельца: лучшая модель, дёшево в этих объёмах ~4–5¢/релиз). ID — константа в одном месте; альтернатива `claude-fable-5` требует доп. обработки `stop_reason: "refusal"` — по умолчанию не надо.
- SDK `@anthropic-ai/sdk` (fetch-based, работает в Workers без node_compat).
- Промпт на английском; в нём: вывод по-русски, 2–4 пункта самого важного для активного пользователя Claude Code + однострочный вердикт «стоит ли обновляться».
- Точный вызов (проверено по актуальной документации, prior-знания SDK устарели):

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const response = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 2048, // запас на thinking
  thinking: { type: "adaptive" },          // budget_tokens на opus-4-8 запрещён (400)
  output_config: {
    effort: "medium",
    format: {                              // structured outputs; НЕ output_format (deprecated)
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          bullets: { type: "array", items: { type: "string" } },
          verdict: { type: "string" },
        },
        required: ["bullets", "verdict"],
        additionalProperties: false,
      },
    },
  },
  messages: [{ role: "user", content: prompt }],
});
// ответ: response.content — массив блоков; JSON лежит в первом блоке type === "text"
const text = response.content.find((b) => b.type === "text").text;
const { bullets, verdict } = JSON.parse(text);
```

- НЕ передавать `temperature`/`top_p`/`top_k` (400 на opus-4-8). Ошибки ловить типизированно (`Anthropic.RateLimitError` и т.п.), при любой ошибке — не постить, не трогать KV.

## Формат поста (Telegram, parse_mode: "HTML")

```
<b>Claude Code 2.1.212</b>

• пункт 1
• пункт 2

Вердикт: …

<blockquote expandable>полные ноты</blockquote>   ← если всё сообщение ≤ ~4000 симв.
<a href="…CHANGELOG.md#21212">Полные ноты</a>     ← иначе
```

- API: `POST https://api.telegram.org/bot<TOKEN>/sendMessage`, body `{chat_id, text, parse_mode: "HTML", link_preview_options: {is_disabled: true}}`.
- Экранировать `<`, `>`, `&` в тексте нот.

## Конфигурация

- Secrets (`wrangler secret put`): `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `TRIGGER_SECRET`.
- Vars (wrangler.jsonc): `TELEGRAM_CHAT_ID` (можно `@username` канала), `DRY_RUN` (`"1"` → собрать пост, вывести в лог, не отправлять, KV не трогать).
- KV: `wrangler kv namespace create RELEASES`.
- Cloudflare-токен / wrangler-логин — глобальный скилл `dev-creds` (Keychain).

## Ручной триггер

Fetch-хендлер: `GET /run?secret=<TRIGGER_SECRET>` — тот же пайплайн вне расписания; `&version=X` — форс-пост конкретной версии; `&dry=1` — оверрайд dry-run. Локально: `wrangler dev --test-scheduled` + `curl http://localhost:8787/__scheduled`.

## Что нужно от владельца (спросить, когда дойдём)

1. Бот у BotFather → токен.
2. Канал, бот — админ, chat id.
3. Ключ Anthropic API (или из dev-creds).

До этого всё разрабатывается в DRY_RUN.

## Верификация

1. `vitest`: парсер changelog на реальном сохранённом фрагменте.
2. `wrangler dev --test-scheduled` c DRY_RUN=1: в логе — собранный пост по свежему релизу; первый запуск постит ровно одну версию.
3. Форс-пост маленькой и большой версии (`/run?version=…&dry=1`) — проверить оба формата (спойлер vs ссылка).
4. После создания бота/канала: деплой, один реальный пост форс-триггером, потом cron.

## Правила для реализации

- НЕ подгружать скилл claude-api заново — всё нужное из него уже перенесено сюда (вызов SDK, модель, ограничения параметров).
- git init сделать в начале реализации.
