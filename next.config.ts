import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // (правка 587) ignoreBuildErrors удалён: с ним продакшн-сборка отправлялась
  // с непроверенными типами (типовые ошибки вроде isTurbo жили в проде).
  // Проверка типов теперь выполняется на каждом `next build`.
  reactStrictMode: false,
  // (релиз) Исключаем из output-file-tracing тяжёлые рантаймы, к которым
  // приложение обращается по АБСОЛЮТНОМУ пути в рантайме, а не через
  // require(): ComfyUI (портативный Python + исходники), embedded Python
  // апскейлера, whisper-STT, ffmpeg и сборку Bonsai.
  //
  // ВНИМАНИЕ: на Windows эта опция НЕ работает — Next склеивает паттерн с
  // корнем проекта через path.join, получаются обратные слэши, а picomatch
  // считает их экранирующими символами (проверено на Next 16.1.1).
  // Реальное ужатие сборки делает scripts/prune-build.mjs — он обрезает
  // готовые манифесты .nft.json после сборки. Опция оставлена для
  // POSIX-сборок, где path.join даёт прямые слэши.
  outputFileTracingExcludes: {
    '*': [
      'ComfyUI-Easy-Install/**',
      'upscale/bin/**',
      'upscale/logs/**',
      'upscale/jobs/**',
      'stt/**',
      'runtime/**',
      'Bonsai_2_27B/**',
      '.local-input/**',
    ],
  },
  webpack: (config) => {
    // Bundle markdown files (e.g. the H3 prompt guide) as raw source strings.
    // (правка 716) Правило действует ТОЛЬКО для webpack. В Next 16 сборкой по
    // умолчанию является Turbopack, а он правила webpack() НЕ распознаёт
    // (см. node_modules/next/dist/docs/.../08-turbopack.md: «Turbopack replaces
    // webpack, so webpack() configs are not recognized»). Поэтому скрипты
    // dev/build теперь явно запускаются с --webpack (package.json), иначе
    // импорт './prompt-guide.md' (src/lib/h3-prompt-spec.ts) не имел бы
    // загрузчика и dev-сервер падал бы на каждом маршруте, тянущем его.
    if (!config.module) config.module = {};
    if (!config.module.rules) config.module.rules = [];
    config.module.rules.push({
      test: /\.md$/,
      type: "asset/source",
      // Исключаем node_modules: без exclude правило втягивало бы .md из
      // зависимостей в бандл как исходный код.
      exclude: /node_modules/,
    });
    return config;
  },
};

export default nextConfig;
