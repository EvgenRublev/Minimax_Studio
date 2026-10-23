### Формат B (Ref2VA) — структура промпта

Шесть полей, строго в этом порядке:

1. `subject_definitions` — референсные активы и метки
2. `summary` — краткое описание задачи и связей
3. `retention_analysis` — что сохраняется / изменяется
4. `detailed_description` — кадры по порядку воспроизведения
5. `overall_soundscape` — атмосфера и физические звуки
6. `non_diegetic_music` — фоновая музыка (или "N/A")

Все секции — на английском (кроме диалогов в `<d>` и видимого в кадре текста).

### Метки и их роли

- `<Subject N>` — актив, абстрагированный из референсов (персонаж, объект, локация)
- `<Picture N>` — изображение-якорь: кадр, композиция, стиль
- `<Video N>` — видео: движение, путь камеры, ритм
- `<Audio N>` — аудио: тембр голоса, звуки, музыкальный стиль

Правило «одна роль»: каждому активу — одна главная задача.
`<Video N>` и `<Audio N>` нумеруются **независимо** от `<Picture N>`.
Персонажа задавай как `<Subject N> is ... in <Picture N> — ...`; отдельная строка `<Picture N>` не нужна.
Каждый прикреплённый референс обязан быть упомянут в промпте своей меткой.

### Маркеры связи

- Видимое: `fully_preserved` | `weak_reference`
- Аудио: `fully_copy` | `reference` | `weak_reference`

### Говорящие персонажи

- Глобальный ID `(Sx)` на каждом вокальном событии; `<Audio N>` переиспользует тот же `(Sx)`.
- `(Sx)` не пишется в `retention_analysis`.

### Пример (реальные промпты — значительно подробнее)

```text
subject_definitions:
<Subject 1> is the coffee-shop interior in <Picture 1> — brick wall, orange sofa, neon sign.
<Subject 2> is the blonde woman in <Picture 2> — long blonde hair, pink shirt.
<Audio 1> is the voice-timbre reference for <Subject 2> (S1).

summary:
[reference generation] <Subject 2> eats a cookie in <Subject 1>, startled by a dog.

retention_analysis:
<Subject 1> ([Shot 1]): fully_preserved — brick wall, orange sofa, neon sign retained.
<Subject 2> ([Shot 1]): fully_preserved — blonde hair, pink shirt retained.
<Audio 1>: reference — vocal timbre guides <Subject 2>'s delivery.

detailed_description:
[Shot 1] Medium shot in <Subject 1>. <Subject 2> (S1) sits on the sofa holding a cookie. A Samoyed lunges at her hand. <Subject 2> (S1) says with light annoyance: <d>[English] Hey! Watch your dog!</d>

overall_soundscape:
Soft indoor coffee-shop room tone.

non_diegetic_music:
N/A
```
