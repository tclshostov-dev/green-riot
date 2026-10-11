import { withSupabase } from "npm:@supabase/server@^1";

async function telegramApi(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
) {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const data = await response.json();

  return {
    ok: response.ok && data.ok === true,
    data,
  };
}

function parseAddPlantCommand(text: string) {
  const withoutCommand = text
    .replace(/^\/addplant(?:@\w+)?/i, "")
    .trim();

  if (!withoutCommand) {
    return null;
  }

  const parts = withoutCommand
    .split("|")
    .map((item) => item.trim());

  return {
    name: parts[0] || null,
    species: parts[1] || null,
    location: parts[2] || null,
    notes: parts[3] || null,
  };
}

export default {
  fetch: withSupabase(
    { auth: "none" },
    async (req, ctx) => {
      try {
        const url = new URL(req.url);

        const botToken =
          Deno.env.get("TELEGRAM_BOT_TOKEN");

        const webhookSecret =
          Deno.env.get("TELEGRAM_WEBHOOK_SECRET");

        const internalSecret =
          Deno.env.get("ZB_INTERNAL_SECRET");

        const supabaseUrl =
          Deno.env.get("SUPABASE_URL");

        if (
          !botToken ||
          !webhookSecret ||
          !internalSecret ||
          !supabaseUrl
        ) {
          return Response.json(
            {
              status: "error",
              message:
                "Не настроены секреты Зелёного бунта",
            },
            { status: 500 },
          );
        }

        // УСТАНОВКА TELEGRAM WEBHOOK
        if (
          url.searchParams.get("setup") === "1" &&
          req.method === "POST"
        ) {
          const body = await req.json();

          if (body.secret !== internalSecret) {
            return Response.json(
              {
                status: "error",
                message: "Неверный внутренний секрет",
              },
              { status: 401 },
            );
          }

          const webhookUrl =
            `${supabaseUrl}/functions/v1/green-riot-core`;

          const telegramResult =
            await telegramApi(
              botToken,
              "setWebhook",
              {
                url: webhookUrl,
                secret_token: webhookSecret,
                allowed_updates: ["message"],
                drop_pending_updates: false,
              },
            );

          if (!telegramResult.ok) {
            return Response.json(
              {
                status: "error",
                message: "Telegram не принял webhook",
                telegram: telegramResult.data,
              },
              { status: 500 },
            );
          }

          return Response.json({
            status: "ok",
            message:
              "🌱 Telegram подключён к ядру Зелёного бунта",
            webhook_url: webhookUrl,
          });
        }

        // ПРОВЕРКА ФУНКЦИИ
        if (req.method === "GET") {
          return Response.json({
            status: "ok",
            message: "🌱 Ядро Зелёного бунта работает",
          });
        }

        // TELEGRAM WEBHOOK
        if (req.method !== "POST") {
          return Response.json(
            {
              status: "error",
              message: "Используйте POST",
            },
            { status: 405 },
          );
        }

        const receivedWebhookSecret =
          req.headers.get(
            "x-telegram-bot-api-secret-token",
          );

        if (receivedWebhookSecret !== webhookSecret) {
          return Response.json(
            {
              status: "error",
              message: "Доступ запрещён",
            },
            { status: 401 },
          );
        }

        const update = await req.json();
        const message = update?.message;

        if (!message) {
          return new Response("ok", { status: 200 });
        }

        const telegramUserId = message?.from?.id;
        const chatId = message?.chat?.id;

        if (!telegramUserId || !chatId) {
          return new Response("ok", { status: 200 });
        }

        const userData = {
          channel: "telegram",
          external_user_id: String(telegramUserId),
          chat_id: String(chatId),
          first_name: message?.from?.first_name ?? null,
          username: message?.from?.username ?? null,
        };

        // СОХРАНЯЕМ / ОБНОВЛЯЕМ ПОЛЬЗОВАТЕЛЯ
        const {
          data: user,
          error: userError,
        } = await ctx.supabaseAdmin
          .from("users")
          .upsert(userData, {
            onConflict: "channel,external_user_id",
          })
          .select(
            "id, channel, external_user_id, chat_id, first_name, username, created_at",
          )
          .single();

        if (userError) {
          return Response.json(
            {
              status: "error",
              message: "Ошибка записи пользователя",
              details: userError.message,
            },
            { status: 500 },
          );
        }

        const text = message?.text ?? "";

        // КОМАНДА /start
        if (text.startsWith("/start")) {
          const replyText =
            "🌱 Добро пожаловать в «Зелёный бунт»!\n\n" +
            "Я на связи и уже подключён " +
            "к облачной памяти.\n\n" +
            "Теперь будем учиться запоминать " +
            "твои растения и историю их жизни.";

          await telegramApi(
            botToken,
            "sendMessage",
            { chat_id: chatId, text: replyText },
          );

          return Response.json({
            status: "ok",
            message: "Команда /start обработана",
            user_id: user.id,
          });
        }

        // ДОБАВЛЕНИЕ РАСТЕНИЯ
        if (/^\/addplant(?:@\w+)?/i.test(text)) {
          const plantData = parseAddPlantCommand(text);

          if (!plantData?.name) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text:
                  "🌱 Добавляем растение.\n\n" +
                  "Формат:\n" +
                  "/addplant Имя | Разновидность | Расположение | Примечание\n\n" +
                  "Например:\n" +
                  "/addplant Фикус | Ficus elastica | Гостиная | Мой первый фикус",
              },
            );

            return Response.json({
              status: "ok",
              message: "Ожидаются данные растения",
              user_id: user.id,
            });
          }

          const {
            data: plant,
            error: plantError,
          } = await ctx.supabaseAdmin
            .from("plants")
            .insert({
              user_id: user.id,
              space_id: null,
              name: plantData.name,
              species: plantData.species,
              location: plantData.location,
              notes: plantData.notes,
              is_active: true,
            })
            .select(
              "id, user_id, space_id, name, species, location, notes, is_active, created_at",
            )
            .single();

          if (plantError) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text:
                  "🌱 Не смог сохранить растение.\n\n" +
                  "Ошибка: " +
                  plantError.message,
              },
            );

            return Response.json({
              status: "error",
              message: "Ошибка записи растения",
              details: plantError.message,
            });
          }

          const replyText =
            "🌿 Растение добавлено!\n\n" +
            `Название: ${plant.name}\n` +
            (plant.species
              ? `Разновидность: ${plant.species}\n`
              : "") +
            (plant.location
              ? `Место: ${plant.location}\n`
              : "") +
            (plant.notes
              ? `Заметка: ${plant.notes}\n`
              : "") +
            `\nID растения: ${plant.id}\n\n` +
            "Теперь это растение хранится в облачной памяти «Зелёного бунта».";

          await telegramApi(
            botToken,
            "sendMessage",
            { chat_id: chatId, text: replyText },
          );

          return Response.json({
            status: "ok",
            message: "Растение успешно добавлено",
            user_id: user.id,
            plant_id: plant.id,
          });
        }

        // ПРОЧИЕ СООБЩЕНИЯ
        const replyText =
          "🌱 Я на связи.\n\n" +
          "Чтобы добавить растение, напиши:\n\n" +
          "/addplant Фикус | Ficus elastica | Гостиная | Мой первый фикус";

        await telegramApi(
          botToken,
          "sendMessage",
          { chat_id: chatId, text: replyText },
        );

        return Response.json({
          status: "ok",
          message: "Сообщение обработано",
          user_id: user.id,
        });
      } catch (error) {
        return Response.json(
          {
            status: "error",
            message: "Ошибка ядра Зелёного бунта",
            details:
              error instanceof Error
                ? error.message
                : String(error),
          },
          { status: 500 },
        );
      }
    },
  ),
};
