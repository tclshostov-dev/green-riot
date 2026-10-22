import { withSupabase } from "npm:@supabase/server@^1";

function mainMenuKeyboard() {
  return {
    keyboard: [
      [
        { text: "🌿 Мои растения" },
        { text: "➕ Добавить растение" },
      ],
      [
        { text: "💧 Отметить полив" },
        { text: "📖 История ухода" },
      ],
      [
        { text: "📝 Записать наблюдение" },
      ],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Выбери действие",
  };
}

async function telegramApi(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
) {
  const requestPayload =
    method === "sendMessage" && !("reply_markup" in payload)
      ? { ...payload, reply_markup: mainMenuKeyboard() }
      : payload;

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
    },
  );

  const data = await response.json();

  return {
    ok: response.ok && data.ok === true,
    data,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize),
    );
  }

  return btoa(binary);
}

async function analyzePlantPhoto(
  apiKey: string,
  imageBytes: Uint8Array,
  mimeType: string,
  plantName: string,
  userNote: string | null,
  historyContext: string,
) {
  const prompt = `
Ты помощник по уходу за комнатными растениями.
Проанализируй фотографию осторожно и отвечай на русском языке.
Не утверждай, что диагноз точный.
Не выдумывай признаки, которых не видно.
Если фото недостаточно чёткое, сообщи об этом.
Не назначай опасные химикаты и неизвестные дозировки.

Название растения: ${plantName}
Заметка пользователя: ${userNote || "не указана"}

История этого растения и справочные сведения (если доступны):
${historyContext || "История и справочные сведения не найдены; не делай вид, что они есть."}

Учитывай историю как контекст, но не считай старые предположения доказанным диагнозом. Если данных недостаточно, задай уточняющие вопросы. Не выдумывай данные каталога.

Верни только JSON с полями:
possible_issue — вероятная причина или "Не удалось определить";
observations — что видно на фотографии;
confidence — число от 0 до 1;
recommendations — массив из 2–5 безопасных советов;
follow_up_questions — массив уточняющих вопросов.
`;

  // Повторяем только временные сетевые ошибки и ответы перегруженного сервиса.
  // Всего до 3 попыток; постоянные ошибки не маскируем долгим ожиданием.
  const requestUrl =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
  const requestOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: bytesToBase64(imageBytes),
            },
          },
        ],
      }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
        maxOutputTokens: 1600,
      },
    }),
  };

  const retryableStatuses = new Set([429, 500, 502, 503, 504]);
  let response: Response | null = null;
  let lastNetworkError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    // Сбрасываем предыдущий ответ: если новая попытка завершится сетевой ошибкой,
    // нельзя случайно продолжить обработку старого HTTP-ответа.
    response = null;
    try {
      response = await fetch(requestUrl, requestOptions);
      lastNetworkError = null;

      if (response.ok || !retryableStatuses.has(response.status) || attempt === 2) {
        break;
      }
    } catch (error) {
      lastNetworkError = error;
      if (attempt === 2) break;
    }

    // Паузы 0.8 и 1.6 секунды; не ждём после последней попытки.
    await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }

  if (!response) {
    throw new Error(
      "Не удалось связаться с Gemini после 3 попыток" +
        (lastNetworkError instanceof Error ? ": " + lastNetworkError.message : ""),
    );
  }

  if (!response.ok) {
    let providerMessage = "";
    try {
      const errorBody = await response.json();
      providerMessage = String(errorBody?.error?.message ?? "");
    } catch {
      providerMessage = "";
    }
    throw new Error(
      `Gemini API вернул HTTP ${response.status}` +
        (providerMessage ? `: ${providerMessage}` : ""),
    );
  }

  const result = await response.json();

  const candidate = result?.candidates?.[0];
  const responseText = candidate?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? "")
    .join("")
    .trim();

  if (!responseText) {
    const finishReason = String(candidate?.finishReason ?? "не указан");
    throw new Error(
      "Gemini не вернул текст анализа (finishReason: " + finishReason + ")",
    );
  }

  // Убираем Markdown-ограждения, если модель неожиданно их добавила.
  const cleanedText = responseText
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleanedText);
  } catch {
    const finishReason = String(candidate?.finishReason ?? "не указан");
    throw new Error(
      "Gemini вернул некорректный или неполный JSON (finishReason: " +
        finishReason +
        "). Повтори анализ; фотография сохранена.",
    );
  }

  return {
    possibleIssue: String(
      parsed.possible_issue || "Не удалось определить",
    ),
    observations: String(parsed.observations || ""),
    confidence: Number.isFinite(Number(parsed.confidence))
      ? Math.max(0, Math.min(1, Number(parsed.confidence)))
      : null,
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations.map(String).slice(0, 5)
      : [],
    followUpQuestions: Array.isArray(parsed.follow_up_questions)
      ? parsed.follow_up_questions.map(String).slice(0, 3)
      : [],
  };
}

function parseAddPlantCommand(text: string) {
  const withoutCommand = text
    .replace(/^\/addplant(?:@\w+)?/i, "")
    .replace(/^растение\s*:/i, "")
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
                allowed_updates: ["message", "callback_query"],
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
        const callbackQuery = update?.callback_query;
        const message = update?.message ?? callbackQuery?.message;
        const sender = callbackQuery?.from ?? message?.from;

        if (!message || !sender) {
          return new Response("ok", { status: 200 });
        }

        const telegramUserId = sender?.id;
        const chatId = message?.chat?.id;

        if (!telegramUserId || !chatId) {
          return new Response("ok", { status: 200 });
        }

        const userData = {
          channel: "telegram",
          external_user_id: String(telegramUserId),
          chat_id: String(chatId),
          first_name: sender?.first_name ?? null,
          username: sender?.username ?? null,
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
        const callbackData = callbackQuery?.data ?? "";

        // СОХРАНЕНИЕ ФОТОГРАФИИ РАСТЕНИЯ
        // Формат подписи: Фото растения 2 | На листьях появились пятна
        if (Array.isArray(message?.photo) && message.photo.length > 0) {
          const caption = String(message?.caption ?? "").trim();
          const photoMatch = caption.match(/^(?:фото\s+растения|растение)\s*#?\s*(\d+)(?:\s*[|—-]\s*(.*))?$/i);

          if (!photoMatch) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text:
                "📸 Фото получил, но пока не знаю, к какому растению его привязать.\n\n" +
                "Отправь фото с подписью в формате:\n" +
                "Фото растения 2 | На листьях появились пятна\n\n" +
                "Число — ID твоего растения из карточки. Заметку после вертикальной черты можно изменить или убрать.",
            });
            return Response.json({ status: "ok", message: "Для фото требуется ID растения" });
          }

          const plantId = Number(photoMatch[1]);
          const userNote = (photoMatch[2] ?? "").trim() || null;

          const { data: photoPlant, error: photoPlantError } = await ctx.supabaseAdmin
            .from("plants")
            .select("id, name, species")
            .eq("id", plantId)
            .eq("user_id", user.id)
            .eq("is_active", true)
            .maybeSingle();

          if (photoPlantError) {
            return Response.json({
              status: "error",
              message: "Не удалось проверить растение для фотографии",
              details: photoPlantError.message,
            }, { status: 500 });
          }

          if (!photoPlant) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "🌱 Не нашёл твоё активное растение с ID " + plantId + ". Проверь ID и отправь фото ещё раз.",
            });
            return Response.json({ status: "ok", message: "Растение для фото не найдено" });
          }

          try {
            // Берём фотографию максимального доступного размера из Telegram.
            const largestPhoto = message.photo[message.photo.length - 1];
            const fileInfoResponse = await fetch(
              `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(largestPhoto.file_id)}`,
            );
            const fileInfo = await fileInfoResponse.json();

            if (!fileInfoResponse.ok || fileInfo.ok !== true || !fileInfo.result?.file_path) {
              throw new Error("Telegram не смог подготовить файл фотографии.");
            }

            const telegramFilePath = String(fileInfo.result.file_path);
            const downloadResponse = await fetch(
              `https://api.telegram.org/file/bot${botToken}/${telegramFilePath}`,
            );

            if (!downloadResponse.ok) {
              throw new Error("Не удалось скачать фотографию из Telegram.");
            }

            const imageBytes = new Uint8Array(await downloadResponse.arrayBuffer());
            const extension = telegramFilePath.split(".").pop()?.toLowerCase() || "jpg";
            const safeExtension = /^[a-z0-9]{1,5}$/.test(extension) ? extension : "jpg";
            const storagePath =
              `${user.id}/${photoPlant.id}/${Date.now()}_${String(largestPhoto.file_unique_id ?? largestPhoto.file_id).replace(/[^a-zA-Z0-9_-]/g, "")}.${safeExtension}`;

            const { error: uploadError } = await ctx.supabaseAdmin.storage
              .from("plant-photos")
              .upload(storagePath, imageBytes, {
                contentType: safeExtension === "png" ? "image/png" : "image/jpeg",
                upsert: false,
              });

            if (uploadError) {
              throw new Error("Не удалось сохранить фото в хранилище: " + uploadError.message);
            }

            const { data: observation, error: observationError } = await ctx.supabaseAdmin
              .from("plant_observations")
              .insert({
                user_id: user.id,
                plant_id: photoPlant.id,
                photo_path: storagePath,
                user_note: userNote,
              })
              .select("id, created_at")
              .single();

            if (observationError) {
              // Убираем загруженный файл, если запись в таблицу не удалась.
              await ctx.supabaseAdmin.storage.from("plant-photos").remove([storagePath]);
              throw new Error("Фото загружено, но запись наблюдения не сохранилась: " + observationError.message);
            }

            let analysisMessage = "";
            const geminiApiKey = Deno.env.get("GEMINI_API_KEY");

            if (geminiApiKey) {
              try {
                const mimeType =
                  safeExtension === "png" ? "image/png" : "image/jpeg";

                // Загружаем только историю текущего пользователя и выбранного растения.
                const [{ data: recentEvents }, { data: recentObservations }] = await Promise.all([
                  ctx.supabaseAdmin
                    .from("plant_events")
                    .select("event_type, description, event_at")
                    .eq("user_id", user.id)
                    .eq("plant_id", photoPlant.id)
                    .order("event_at", { ascending: false })
                    .limit(5),
                  ctx.supabaseAdmin
                    .from("plant_observations")
                    .select("user_note, ai_analysis, possible_issue, recommendations, created_at")
                    .eq("user_id", user.id)
                    .eq("plant_id", photoPlant.id)
                    .order("created_at", { ascending: false })
                    .limit(3),
                ]);

                let catalogContext = "";
                if (photoPlant.species) {
                  const { data: catalogPlant } = await ctx.supabaseAdmin
                    .from("plant_catalog")
                    .select("russian_name, scientific_name, family, description, care_guide")
                    .eq("scientific_name", String(photoPlant.species).trim())
                    .maybeSingle();
                  if (catalogPlant) {
                    catalogContext = JSON.stringify(catalogPlant);
                  }
                }

                const historyContext = [
                  catalogContext ? "Справочник видов: " + catalogContext : "",
                  (recentEvents ?? []).length
                    ? "Последние события ухода: " + JSON.stringify(recentEvents)
                    : "",
                  (recentObservations ?? []).length
                    ? "Предыдущие фото-наблюдения: " + JSON.stringify(recentObservations)
                    : "",
                ].filter(Boolean).join("\n");

                const analysis = await analyzePlantPhoto(
                  geminiApiKey,
                  imageBytes,
                  mimeType,
                  String(photoPlant.name),
                  userNote,
                  historyContext,
                );

                const recommendationsText =
                  analysis.recommendations.length > 0
                    ? analysis.recommendations
                        .map((item, index) => `${index + 1}. ${item}`)
                        .join("\n")
                    : "Пока нет рекомендаций.";

                const confidenceText =
                  analysis.confidence === null
                    ? "не определена"
                    : `${Math.round(analysis.confidence * 100)}%`;

                const aiText =
                  `Вероятная причина: ${analysis.possibleIssue}\n\n` +
                  `Что видно на фото: ${analysis.observations}\n\n` +
                  `Уверенность модели: ${confidenceText}`;

                const { error: analysisSaveError } =
                  await ctx.supabaseAdmin
                    .from("plant_observations")
                    .update({
                      ai_analysis: aiText,
                      possible_issue: analysis.possibleIssue,
                      recommendations: recommendationsText,
                    })
                    .eq("id", observation.id)
                    .eq("user_id", user.id);

                if (analysisSaveError) {
                  throw new Error("Ошибка записи анализа в базу: " + analysisSaveError.message);
                }

                const questionsText =
                  analysis.followUpQuestions.length > 0
                    ? "\n\nУточни, пожалуйста:\n" +
                      analysis.followUpQuestions
                        .map((item) => "• " + item)
                        .join("\n")
                    : "";

                analysisMessage =
                  "\n\n🔎 Предварительный ИИ-анализ\n\n" +
                  aiText +
                  "\n\n🌱 Что можно сделать:\n" +
                  recommendationsText +
                  questionsText +
                  "\n\nВажно: это предварительная оценка по фото, а не точный диагноз.";
              } catch (_analysisError) {
                const diagnosticMessage =
                  _analysisError instanceof Error
                    ? _analysisError.message
                    : String(_analysisError);
                console.error("GREEN_RIOT_GEMINI_ANALYSIS_FAILED:", diagnosticMessage);
                analysisMessage =
                  "\n\n⚠️ Фото сохранено, но ИИ-анализ сейчас не удался. " +
                  "Снимок не потерян. Причина: " + diagnosticMessage;
              }
            } else {
              analysisMessage =
                "\n\n⚠️ Не найден ключ Gemini. Фото сохранено, " +
                "но ИИ-анализ не запущен.";
            }

            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text:
                "🌿 Фото сохранено!\n\n" +
                "Растение: " + photoPlant.name + "\n" +
                "ID наблюдения: " + observation.id + "\n" +
                (userNote ? "Твоя заметка: " + userNote + "\n" : "") +
                "\n📦 Фото находится в закрытом хранилище." +
                analysisMessage,
            });

            return Response.json({
              status: "ok",
              message: "Фото растения сохранено",
              user_id: user.id,
              plant_id: photoPlant.id,
              observation_id: observation.id,
            });
          } catch (photoError) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text:
                "⚠️ Не удалось сохранить фото. Попробуй ещё раз.\n\n" +
                "Если ошибка повторится, сообщи мне — проверим настройки хранилища.",
            });
            return Response.json({
              status: "error",
              message: "Ошибка сохранения фото растения",
              details: photoError instanceof Error ? photoError.message : String(photoError),
            }, { status: 500 });
          }
        }

        // ОБРАБОТКА НАЖАТИЙ НА РАСТЕНИЯ
        if (callbackQuery && callbackData) {
          await telegramApi(
            botToken,
            "answerCallbackQuery",
            { callback_query_id: callbackQuery.id },
          );

          const callbackMatch =
            callbackData.match(/^(plant|history|water|photo|note):(\d+)$/);

          if (!callbackMatch) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text: "Эта кнопка устарела. Открой меню и выбери действие ещё раз.",
              },
            );

            return Response.json({
              status: "ok",
              message: "Неизвестное действие кнопки",
            });
          }

          const action = callbackMatch[1];
          const plantId = Number(callbackMatch[2]);

          const {
            data: selectedPlant,
            error: selectedPlantError,
          } = await ctx.supabaseAdmin
            .from("plants")
            .select("id, name, species, location, notes, created_at")
            .eq("id", plantId)
            .eq("user_id", user.id)
            .eq("is_active", true)
            .maybeSingle();

          if (selectedPlantError) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text: "Не удалось загрузить растение. Попробуй ещё раз.",
              },
            );

            return Response.json({
              status: "error",
              message: "Ошибка чтения растения",
              details: selectedPlantError.message,
            }, { status: 500 });
          }

          if (!selectedPlant) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text: "Не нашёл это растение среди твоих активных растений.",
              },
            );

            return Response.json({
              status: "ok",
              message: "Растение недоступно этому пользователю",
            });
          }

          if (action === "photo") {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text:
                "📸 Отправь новую фотографию этого растения с подписью:\n\n" +
                `Фото растения ${selectedPlant.id} | Что изменилось или беспокоит` +
                "\n\nФото сохранится в истории, а ИИ попробует оценить состояние с учётом предыдущих наблюдений.",
            });
            return Response.json({
              status: "ok",
              message: "Показана инструкция для анализа фото",
              plant_id: selectedPlant.id,
            });
          }

          if (action === "note") {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text:
                "📝 Чтобы записать наблюдение для " + selectedPlant.name + ", отправь сообщение в формате:\n\n" +
                `Наблюдение ${selectedPlant.id} | Текст наблюдения` +
                "\n\nНапример: Наблюдение " + selectedPlant.id + " | Появились новые сухие кончики.",
            });
            return Response.json({
              status: "ok",
              message: "Показана инструкция для записи наблюдения",
              plant_id: selectedPlant.id,
            });
          }

          if (action === "water") {
            const eventAt = new Date().toISOString();

            const {
              data: event,
              error: eventError,
            } = await ctx.supabaseAdmin
              .from("plant_events")
              .insert({
                user_id: user.id,
                plant_id: selectedPlant.id,
                event_type: "watering",
                description: "Полив отмечен пользователем через меню Telegram.",
                amount_value: null,
                amount_unit: null,
                event_at: eventAt,
                created_at: eventAt,
              })
              .select("id, event_at")
              .single();

            if (eventError) {
              await telegramApi(
                botToken,
                "sendMessage",
                {
                  chat_id: chatId,
                  text: "Не удалось сохранить полив. Попробуй ещё раз позже.",
                },
              );

              return Response.json({
                status: "error",
                message: "Ошибка записи полива из меню",
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
                  `Растение: ${selectedPlant.name}\n` +
                  `ID события: ${event.id}\n` +
                  "Запись сохранена в облачной памяти.",
              },
            );

            return Response.json({
              status: "ok",
              message: "Полив записан из меню",
              user_id: user.id,
              plant_id: selectedPlant.id,
              event_id: event.id,
            });
          }

          const {
            data: plantEvents,
            error: plantEventsError,
          } = await ctx.supabaseAdmin
            .from("plant_events")
            .select("id, event_type, description, event_at")
            .eq("user_id", user.id)
            .eq("plant_id", selectedPlant.id)
            .order("event_at", { ascending: false })
            .limit(5);

          if (plantEventsError) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text: "Карточка открылась, но историю ухода загрузить не удалось.",
              },
            );

            return Response.json({
              status: "error",
              message: "Ошибка чтения истории ухода",
              details: plantEventsError.message,
            }, { status: 500 });
          }

          const eventLabels: Record<string, string> = {
            watering: "Полив",
            fertilizing: "Подкормка",
            repotting: "Пересадка",
            treatment: "Обработка",
            pruning: "Обрезка",
            moved: "Перемещение",
            observation: "Наблюдение",
          };

          const eventsText = (plantEvents ?? []).length
            ? (plantEvents ?? []).map((event, index) => {
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

          const heading =
            action === "history"
              ? "📖 История ухода"
              : "🌿 Карточка растения";

          const details =
            `${heading}\n\nНазвание: ${selectedPlant.name}\n` +
            (selectedPlant.species ? `Разновидность: ${selectedPlant.species}\n` : "") +
            (selectedPlant.location ? `Место: ${selectedPlant.location}\n` : "") +
            (selectedPlant.notes ? `Заметка: ${selectedPlant.notes}\n` : "") +
            `ID растения: ${selectedPlant.id}\n\nПоследние события ухода:\n` +
            eventsText;

          const plantActionsKeyboard = {
            inline_keyboard: [
              [
                { text: "📸 Анализ фото", callback_data: `photo:${selectedPlant.id}` },
                { text: "📖 История", callback_data: `history:${selectedPlant.id}` },
              ],
              [
                { text: "💧 Отметить полив", callback_data: `water:${selectedPlant.id}` },
                { text: "📝 Записать наблюдение", callback_data: `note:${selectedPlant.id}` },
              ],
            ],
          };

          await telegramApi(
            botToken,
            "sendMessage",
            {
              chat_id: chatId,
              text: details,
              reply_markup: plantActionsKeyboard,
            },
          );

          return Response.json({
            status: "ok",
            message: "Карточка и история отправлены из меню",
            user_id: user.id,
            plant_id: selectedPlant.id,
            events_count: (plantEvents ?? []).length,
          });
        }

        // КОМАНДЫ РУССКОГО МЕНЮ
        const menuAction = text.trim();

        if (["🌿 Мои растения", "Мои растения"].includes(menuAction)) {
          const {
            data: plants,
            error: plantsError,
          } = await ctx.supabaseAdmin
            .from("plants")
            .select("id, name, species, location")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("created_at", { ascending: false })
            .limit(50);

          if (plantsError) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "Не удалось загрузить список растений. Попробуй позже.",
            });
            return Response.json({
              status: "error",
              message: "Ошибка списка растений",
              details: plantsError.message,
            }, { status: 500 });
          }

          if (!(plants ?? []).length) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "🌱 Пока у тебя нет растений. Нажми «➕ Добавить растение», чтобы создать первое.",
            });
          } else {
            const keyboard = {
              inline_keyboard: (plants ?? []).map((plant) => [{
                text: `🌿 ${plant.name} · ID ${plant.id}`,
                callback_data: `plant:${plant.id}`,
              }]),
            };

            const listText =
              "🌿 Твои растения:\n\n" +
              (plants ?? []).map((plant, index) =>
                `${index + 1}. ${plant.name}` +
                (plant.species ? ` — ${plant.species}` : "") +
                (plant.location ? ` · ${plant.location}` : "") +
                ` · ID ${plant.id}`
              ).join("\n") +
              "\n\nНажми на растение, чтобы открыть карточку и историю.";

            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: listText,
              reply_markup: keyboard,
            });
          }

          return Response.json({
            status: "ok",
            message: "Список растений отправлен",
            user_id: user.id,
          });
        }

        if (["📖 История ухода", "История ухода"].includes(menuAction)) {
          const {
            data: plants,
            error: plantsError,
          } = await ctx.supabaseAdmin
            .from("plants")
            .select("id, name")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("created_at", { ascending: false })
            .limit(50);

          if (plantsError) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "Не удалось загрузить растения для просмотра истории.",
            });
            return Response.json({
              status: "error",
              message: "Ошибка списка растений для истории",
              details: plantsError.message,
            }, { status: 500 });
          }

          if (!(plants ?? []).length) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "🌱 Сначала добавь растение через «➕ Добавить растение».",
            });
          } else {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "📖 Выбери растение, историю которого хочешь посмотреть:",
              reply_markup: {
                inline_keyboard: (plants ?? []).map((plant) => [{
                  text: `📖 ${plant.name} · ID ${plant.id}`,
                  callback_data: `history:${plant.id}`,
                }]),
              },
            });
          }

          return Response.json({
            status: "ok",
            message: "Выбор растения для истории отправлен",
            user_id: user.id,
          });
        }

        if (["💧 Отметить полив", "Отметить полив"].includes(menuAction)) {
          const {
            data: plants,
            error: plantsError,
          } = await ctx.supabaseAdmin
            .from("plants")
            .select("id, name")
            .eq("user_id", user.id)
            .eq("is_active", true)
            .order("created_at", { ascending: false })
            .limit(50);

          if (plantsError) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "Не удалось загрузить растения для отметки полива.",
            });
            return Response.json({
              status: "error",
              message: "Ошибка списка растений для полива",
              details: plantsError.message,
            }, { status: 500 });
          }

          if (!(plants ?? []).length) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "🌱 Сначала добавь растение через «➕ Добавить растение».",
            });
          } else {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "💧 Выбери растение, которое ты полил:",
              reply_markup: {
                inline_keyboard: (plants ?? []).map((plant) => [{
                  text: `💧 ${plant.name} · ID ${plant.id}`,
                  callback_data: `water:${plant.id}`,
                }]),
              },
            });
          }

          return Response.json({
            status: "ok",
            message: "Выбор растения для полива отправлен",
            user_id: user.id,
          });
        }

        if (["📝 Записать наблюдение", "Записать наблюдение"].includes(menuAction)) {
          await telegramApi(botToken, "sendMessage", {
            chat_id: chatId,
            text:
              "📝 Запишем наблюдение за растением. Отправь одним сообщением в формате:\n\n" +
              "Наблюдение 3 | Сухие коричневые кончики, полив примерно раз в неделю, внутренний горшок со сливом.\n\n" +
              "Замени число на ID своего растения, а после вертикальной черты опиши, что заметил. Запись попадёт в историю растения.",
          });
          return Response.json({
            status: "ok",
            message: "Формат наблюдения показан",
            user_id: user.id,
          });
        }

        if (["➕ Добавить растение", "Добавить растение"].includes(menuAction)) {
          await telegramApi(botToken, "sendMessage", {
            chat_id: chatId,
            text:
              "➕ Добавим растение. Отправь одним сообщением:\n\n" +
              "Растение: Фикус | Ficus elastica | Гостиная | Мой первый фикус\n\n" +
              "Порядок: название | разновидность | место | заметка.\n" +
              "Последние поля можно оставить пустыми.\n\n" +
              "Например: Растение: Монстера | Monstera deliciosa | Кабинет | У окна",
          });

          return Response.json({
            status: "ok",
            message: "Формат добавления растения показан",
            user_id: user.id,
          });
        }

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

        // СОХРАНЕНИЕ ТЕКСТОВОГО НАБЛЮДЕНИЯ
        const observationMatch = text.trim().match(/^наблюдение\s*#?\s*(\d+)\s*[|—-]\s*(.+)$/i);
        if (observationMatch) {
          const plantId = Number(observationMatch[1]);
          const description = observationMatch[2].trim();
          if (!description) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "Добавь описание после вертикальной черты.",
            });
            return Response.json({ status: "ok", message: "Пустое наблюдение" });
          }

          const { data: plant, error: plantError } = await ctx.supabaseAdmin
            .from("plants")
            .select("id, name")
            .eq("id", plantId)
            .eq("user_id", user.id)
            .eq("is_active", true)
            .maybeSingle();

          if (plantError || !plant) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: plantError
                ? "Не удалось проверить растение. Попробуй ещё раз."
                : "Не нашёл твоё активное растение с ID " + plantId + ". Проверь номер в карточке.",
            });
            return Response.json({
              status: plantError ? "error" : "ok",
              message: plantError ? "Ошибка проверки растения для наблюдения" : "Растение для наблюдения не найдено",
              details: plantError?.message,
            }, plantError ? { status: 500 } : { status: 200 });
          }

          const eventAt = new Date().toISOString();
          const { data: event, error: eventError } = await ctx.supabaseAdmin
            .from("plant_events")
            .insert({
              user_id: user.id,
              plant_id: plant.id,
              event_type: "observation",
              description,
              amount_value: null,
              amount_unit: null,
              event_at: eventAt,
              created_at: eventAt,
            })
            .select("id, event_at")
            .single();

          if (eventError) {
            await telegramApi(botToken, "sendMessage", {
              chat_id: chatId,
              text: "Не удалось сохранить наблюдение. Попробуй позже.",
            });
            return Response.json({
              status: "error",
              message: "Ошибка записи наблюдения",
              details: eventError.message,
            }, { status: 500 });
          }

          await telegramApi(botToken, "sendMessage", {
            chat_id: chatId,
            text:
              "📝 Наблюдение сохранено в истории!\n\n" +
              "Растение: " + plant.name + "\n" +
              "ID растения: " + plant.id + "\n" +
              "Описание: " + description + "\n" +
              "ID события: " + event.id,
          });
          return Response.json({
            status: "ok",
            message: "Наблюдение сохранено",
            user_id: user.id,
            plant_id: plant.id,
            event_id: event.id,
          });
        }

        // ДОБАВЛЕНИЕ РАСТЕНИЯ
        if (/^\/addplant(?:@\w+)?/i.test(text) || /^растение\s*:/i.test(text)) {
          const plantData = parseAddPlantCommand(text);

          if (!plantData?.name) {
            await telegramApi(
              botToken,
              "sendMessage",
              {
                chat_id: chatId,
                text:
                  "🌱 Добавляем растение.\n\n" +
                  "Отправь одним сообщением:\n" +
                  "Растение: Фикус | Ficus elastica | Гостиная | Мой первый фикус\n\n" +
                  "Можно также использовать старую команду /addplant.",
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
            observation: "Наблюдение",
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
          "🌱 Я на связи! Выбери действие в русском меню под полем ввода.\n\n" +
          "Чтобы добавить растение, нажми «➕ Добавить растение». " +
          "Чтобы открыть сад — «🌿 Мои растения».";

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
