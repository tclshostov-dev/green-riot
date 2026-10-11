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

        // ПРОСМОТР КАРТОЧКИ И ИСТОРИИ РАСТЕНИЯ
        if (/^\/plant(?:@\w+)?(?:\s|$)/i.test(text)) {
          const match = text.match(/^\/plant(?:@\w+)?\s+(\d+)\s*$/i);

          if (!match) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text:
                  "🌿 Чтобы открыть карточку растения, напиши:\n\n" +
                  "/plant 1\n\n" +
                  "Число — ID растения.",
              },
            );

            return Response.json({
              status: "ok",
              message: "Запрошен ID растения",
              user_id: user.id,
            });
          }

          const plantId = Number(match[1]);

          if (!Number.isSafeInteger(plantId) || plantId <= 0) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text: "ID растения должен быть положительным целым числом.",
              },
            );

            return Response.json({
              status: "ok",
              message: "Некорректный ID растения",
              user_id: user.id,
            });
          }

          // Проверяем владельца: чужие растения и их история недоступны
          const {
            data: plant,
            error: plantError,
          } = await ctx.supabaseAdmin
            .from("plants")
            .select("id, name, species, location, notes, created_at")
            .eq("id", plantId)
            .eq("user_id", user.id)
            .eq("is_active", true)
            .maybeSingle();

          if (plantError) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text: "Не удалось загрузить карточку растения. Попробуй позже.",
              },
            );

            return Response.json({
              status: "error",
              message: "Ошибка чтения растения",
              details: plantError.message,
            }, { status: 500 });
          }

          if (!plant) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text:
                  "🌱 Не нашёл активное растение с таким ID среди твоих растений.\n\n" +
                  "Проверь ID растения.",
              },
            );

            return Response.json({
              status: "ok",
              message: "Растение не найдено для этого пользователя",
              user_id: user.id,
            });
          }

          const {
            data: events,
            error: eventsError,
          } = await ctx.supabaseAdmin
            .from("plant_events")
            .select("id, event_type, description, event_at")
            .eq("user_id", user.id)
            .eq("plant_id", plant.id)
            .order("event_at", { ascending: false })
            .limit(5);

          if (eventsError) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text: "Карточка растения найдена, но историю ухода загрузить не удалось.",
              },
            );

            return Response.json({
              status: "error",
              message: "Ошибка чтения истории растения",
              details: eventsError.message,
            }, { status: 500 });
          }

          const eventLabels: Record<string, string> = {
            watering: "Полив",
            fertilizing: "Подкормка",
            repotting: "Пересадка",
            treatment: "Обработка",
            pruning: "Обрезка",
            moved: "Перемещение",
          };

          const historyText = (events ?? []).length
            ? (events ?? []).map((event, index) => {
                const label = eventLabels[event.event_type] ?? event.event_type;
                const date = new Date(event.event_at).toLocaleString(
                  "ru-RU",
                  { timeZone: "Europe/Moscow" },
                );
                const description = event.description
                  ? "\n   " + event.description
                  : "";
                return `${index + 1}. ${label} — ${date}${description}`;
              }).join("\n")
            : "Пока нет записанных событий ухода.";

          const replyText =
            "🌿 Карточка растения\n\n" +
            `Название: ${plant.name}\n` +
            (plant.species ? `Разновидность: ${plant.species}\n` : "") +
            (plant.location ? `Место: ${plant.location}\n` : "") +
            (plant.notes ? `Заметка: ${plant.notes}\n` : "") +
            `ID растения: ${plant.id}\n\n` +
            "Последние события ухода:\n" +
            historyText;

          await telegramApi(
            botToken,
            "sendMessage",
            { chat_id: chatId, text: replyText },
          );

          return Response.json({
            status: "ok",
            message: "Карточка и история растения отправлены",
            user_id: user.id,
            plant_id: plant.id,
            events_count: (events ?? []).length,
          });
        }

        // СОХРАНЕНИЕ СОБЫТИЯ ПОЛИВА
        if (/^\/water(?:@\w+)?(?:\s|$)/i.test(text)) {
          const match = text.match(/^\/water(?:@\w+)?\s+(\d+)\s*$/i);

          if (!match) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text:
                  "🌱 Чтобы отметить полив, напиши:\n\n" +
                  "/water 1\n\n" +
                  "Число — это ID растения из карточки.",
              },
            );

            return Response.json({
              status: "ok",
              message: "Запрошен ID растения для полива",
              user_id: user.id,
            });
          }

          const plantId = Number(match[1]);

          if (!Number.isSafeInteger(plantId) || plantId <= 0) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text: "Номер растения должен быть положительным целым числом.",
              },
            );

            return Response.json({
              status: "ok",
              message: "Некорректный ID растения",
              user_id: user.id,
            });
          }

          // Разрешаем записывать события только для собственного активного растения
          const {
            data: plant,
            error: plantLookupError,
          } = await ctx.supabaseAdmin
            .from("plants")
            .select("id, name")
            .eq("id", plantId)
            .eq("user_id", user.id)
            .eq("is_active", true)
            .maybeSingle();

          if (plantLookupError) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text: "Не удалось проверить растение. Попробуй ещё раз позже.",
              },
            );

            return Response.json({
              status: "error",
              message: "Ошибка проверки растения",
              details: plantLookupError.message,
            }, { status: 500 });
          }

          if (!plant) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text:
                  "🌱 Не нашёл активное растение с таким ID среди твоих растений.\n\n" +
                  "Проверь ID в карточке растения.",
              },
            );

            return Response.json({
              status: "ok",
              message: "Растение не найдено для этого пользователя",
              user_id: user.id,
            });
          }

          const eventAt = new Date().toISOString();

          const {
            data: event,
            error: eventError,
          } = await ctx.supabaseAdmin
            .from("plant_events")
            .insert({
              user_id: user.id,
              plant_id: plant.id,
              event_type: "watering",
              description: "Полив отмечен пользователем через Telegram.",
              amount_value: null,
              amount_unit: null,
              event_at: eventAt,
              created_at: eventAt,
            })
            .select("id, event_type, event_at, plant_id")
            .single();

          if (eventError) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text:
                  "🌱 Не удалось сохранить полив.\n\n" +
                  "Ошибка: " + eventError.message,
              },
            );

            return Response.json({
              status: "error",
              message: "Ошибка записи события полива",
              details: eventError.message,
            }, { status: 500 });
          }

          await telegramApi(
            botToken,
            "sendMessage",
            {
              chat_id: chatId,
              text:
                "💧 Полив записан в историю!\n\n" +
                "Растение: " + plant.name + "\n" +
                "ID растения: " + plant.id + "\n" +
                "ID события: " + event.id + "\n\n" +
                "Теперь полив сохранён в облачной памяти «Зелёного бунта».",
            },
          );

          return Response.json({
            status: "ok",
            message: "Событие полива записано",
            user_id: user.id,
            plant_id: plant.id,
            event_id: event.id,
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
