# Key moments in a recording

Clipy picks moments that help someone understand what happened on screen. Each
moment has a timestamp and a frame: the screenshot captured at the moment's
`frame_at_ms`. Rules run locally, even without a model.

## What the rules notice

- **Hold Control to highlight.** In the desktop app, hold Control while the
  pointer is over something to mark it as important. A brief tap is ignored;
  a sustained highlight becomes a moment, with its frame taken while the
  highlight is still visible.
- **Pen strokes.** Drawing, boxing, or pointing with the pen marks the area
  for a moment. Strokes close together are grouped as one drawing, and the
  frame shows the finished mark.
- **Click clusters.** Repeated clicks close together in time and space are
  grouped into one moment: clicks no more than **1500 ms** apart and within
  **28 px** of one another belong to the same cluster. Accessibility labels
  can add the name of the clicked control.
- **Pointer rests.** A pointer that stays within a small area for at least
  **900 ms** is recorded as a rest. A rest can help anchor a spoken cue to the
  place being discussed. By itself, it becomes a moment only when it lasts at
  least **2000 ms**.

## What a model adds

With a model provider configured, Clipy can use the transcript to pick spoken
cues such as “this button” or “it breaks here.” It combines those cues with
the same local evidence: a nearby click, highlight, drawing, or pointer rest
can identify the exact place on screen. Without a model, the rules still find
the gestures and interactions above. A configured provider receives the
transcript and compact cursor context; video and screenshots stay on the
machine.

## A moment and its frame in AREC

An AREC is plain Markdown. A moment can include the frame time and an embedded
image, for example:

```markdown
## Key moments

- [00:00:00] Clicks 'Save' — frame_at_ms: 0
  ![Frame at 00:00:00](frames/frame-0.jpg)
```

The frame time can differ from the moment's timestamp when a gesture is best
shown just before it ends. See the [AREC format](https://arecformat.org/spec).
