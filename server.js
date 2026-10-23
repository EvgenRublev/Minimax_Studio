#!/usr/bin/env node
/**
 * MiniMax H3 Studio
 * Server entry point for Next.js 16.
 */
process.env.NODE_ENV = 'production'
process.env.NEXT_TELEMETRY_DISABLED = '1'

const http = require('http')
const next = require('next')

const dir = __dirname
// Default to loopback: binding 0.0.0.0 triggers a Windows Firewall prompt on
// fresh machines. Set BIND_HOST=0.0.0.0 to expose the UI on the LAN.
const hostname = process.env.BIND_HOST || '127.0.0.1'
// (правка 716) PORT валидируется: 'abc' → NaN, 99999 → вне диапазона.
// Раньше порт молча превращался в невалидный, и Electron ждал 120 с, а
// потом показывал «сервер не поднялся» без внятной причины.
const parsedPort = parseInt(process.env.PORT || '3000', 10)
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  console.error(`Invalid PORT: ${process.env.PORT}`)
  process.exit(1)
}
const port = parsedPort

// Handle uncaught exceptions gracefully (e.g. "Controller is already closed")
// (правка 716) Логируем ПОЛНЫЙ объект ошибки: err.message у не-Error'ов
// равен undefined, и в лог уходило «Uncaught Exception: undefined».
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err)
  // Don't exit — let the server keep running
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason)
})

async function start() {
  const app = next({
    dir,
    hostname,
    port,
    dev: false,
  })

  await app.prepare()

  const server = http.createServer((req, res) => {
    // (правка 716) requestHandler — АСИНХРОННАЯ функция, её промис нужно
    // обработать. Раньше он отбрасывался, и при reject запрос ВИСЕЛ БЕЗ
    // ОТВЕТА (клиент ждал до своего таймаута) — в том числе проба
    // готовности Electron'а.
    Promise.resolve(app.requestHandler(req, res)).catch((err) => {
      console.error('Request failed:', err && err.stack ? err.stack : err)
      try {
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
        }
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
      } catch { /* соединение уже закрыто */ }
    })
  })

  // (правка 587) Раньше 'error' сервера (EADDRINUSE и т.п.) улетал в
  // uncaughtException-обработчик выше и ПРОГЛАТЫВАЛСЯ: процесс продолжал
  // жить, ничего не обслуживая, — невидимый зомби под start /b, а проба
  // готовности в start.bat могла пройти по ответам СТАРОГО сервера.
  server.on('error', (err) => {
    console.error('Server error (fatal):', err.message)
    process.exit(1)
  })

  server.listen(port, hostname, () => {
    console.log(`  Web UI:   http://localhost:${port}`)
    console.log(`  ComfyUI:  http://127.0.0.1:${process.env.COMFY_PORT || 8188}`)
  })

  // (правка 587) Родитель-страж: Electron передаёт свой PID в MINIMAX_PARENT_PID.
  // Если Electron умер (краш/жёсткое убийство), его before-quit-очистка не
  // выполнится — без стража server.js и его питон-дети (llm/stt) продолжали
  // бы жить вхолостую. process.exit(0) запускает exit-хуки раннеров
  // (killChildSync), убивающие питон-серверы.
  const parentPid = parseInt(process.env.MINIMAX_PARENT_PID || '', 10)
  if (parentPid > 0) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0)
      } catch {
        console.log('[server] Parent process is gone, shutting down.')
        process.exit(0)
      }
    }, 5000).unref()
  }

  // Graceful shutdown
  // (правка 587) close() ждёт keep-alive-соединения браузера вечно —
  // принудительно закрываем соединения и ставим таймер принудительного
  // выхода, чтобы завершение всегда реально завершало процесс.
  const shutdown = (sig) => {
    console.log(`[server] ${sig} received, shutting down.`)
    server.close(() => process.exit(0))
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

start().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
