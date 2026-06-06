All audio is pre‑rendered in segments. Tags may be nested.
Dynamic expressions are evaluated once per segment and baked into the waveform.
Interactive buttons (<until>) split the document into independently rendered segments that are stitched at runtime.

---

1. Fundamental concepts

Segment boundaries

A segment is the unit of pre‑rendering. It is defined by:

· The whole document (if no <until> tags)
· Each part before, inside, and after an <until> tag

Tones play until the end of their enclosing tag.

Foreground vs. background

· Foreground content (speech, sound effects, pauses) is laid out sequentially; one element starts after the previous one finishes.
· Background content (tones, background audio placed via <background>) plays concurrently with the foreground, starting at the point where the tag appears.

---

2. Tag reference

<voice>

Changes the speaking voice.

```xml
<voice speaker="male|male2|female|female2"
       [pitch="<expression>"]   <!-- 0.5–2.0, 1.0 = no change -->
       [volume="<expression>"]  <!-- 0.0–1.5 -->
       [speed="<expression>"]   <!-- 0.5–1.5, changes pitch + speed -->
>
  ... spoken content ...
</voice>
```

---

<speed value="<expression>"> ... </speed>

Adjusts playback speed (and pitch) of its content.
Clamped to 0.5 – 1.5.

---

<volume value="<expression>"> ... </volume>

Adjusts volume of its content. Clamped to 0.0 – 1.5.

---

<pause duration="<number>"/>

Inserts silence for the given number of seconds.

---

<sound>

Plays a pre‑built sound effect in the foreground.

```xml
<sound type="beep|pop|bubble_pop|camera_shutter|censor_beep|heart_beat|padlock|snap|ding|swoosh|click|error|success|bell|water_drop"
       [volume="<expression>"]
       [speed="<expression>"]/>
```

---

<tone>

Plays a continuous background tone (sine, noise, binaural…) from the point where the tag appears until the end of the current segment.

```xml
<tone type="binaural|isochronic|noise|wave"
      preset="theta|alpha|beta|delta|pinknoise|whitenoise|brownnoise|sine|square|sawtooth|triangle"
      [frequency="<number>"]      <!-- required for wave types -->
      [volume="<expression>"]
      [speed="<expression>"]/>
```

Because tones are always background, you never need to wrap them in <background> or <overlay>.
They simply start playing when encountered and continue until the segment finishes.

---

<effect>

Applies an audio effect to its content.

```xml
<effect type="echo|reverb|filter"
        [preset="light|medium|heavy|small_room|large_hall|cathedral|plate|lowpass|highpass"]
        [cutoff="<number>"]>   <!-- frequency in Hz, required for filters -->
  ... content ...
</effect>
```

---

<overlay>

Layers multiple audio parts.
The overlay ends when the longest part finishes, unless an explicit duration is given.

```xml
<overlay [duration="<seconds>"]>
  <part [looped="true"] [volume="<expression>"] [speed="<expression>"]> ... </part>
  <part ...> ... </part>
  ...
</overlay>
```

· If no duration is set, at least one part must be non‑looped so the overlay has a finite length.
· With duration, all parts may be looped – the overlay will last exactly that many seconds.

---

<loop loops="<integer>"> ... </loop>

Repeats its content N times.

---

<background>

A convenient shorthand for layering a sound or music under the text that follows it, without writing a full <overlay>.
The background content starts playing at the same time as the immediately following foreground content.

```xml
<background [volume="<expression>"] [speed="<expression>"]> ... </background>
```

· The background element itself does not advance the foreground timeline – it acts as a parallel layer.
· Its duration is exactly the rendered length of its inner content.
· The combined segment (background + following foreground) lasts as long as the longer of the two.

Common use: place a subtle sound effect under a specific word.

```xml
<voice speaker="female">
  Hello, the
  <background><sound type="bubble_pop" volume="0.6"/></background>
  bubble popped!
</voice>
```

This is semantically equivalent to:

```xml
<voice speaker="female">
Hello, the
<overlay>
  <part><sound type="bubble_pop" volume="0.6"/></part>
  <part>bubble popped!</part>
</overlay>
</voice>
```

Multiple <background> tags can be used in the same segment; each starts at its respective position.
They are automatically mixed together.

---

<until>

Makes playback interactive.

```xml
<until button="Button Label"
       [waiting-sound="<sound-type>"]
       [waiting-sound-volume="<expression>"]
       [pre-pause="<seconds>"]
       [post-pause="<seconds>"]>
  ... spoken / audio content gets repeated until button is pressed ...
</until>
```

Attributes:

· button – the text that appears on the button.
· waiting-sound – if provided, the named sound effect is automatically looped in the background while waiting. (No need for a manual <overlay>.)
· waiting-sound-volume – volume for the waiting sound (default 0.5).
· pre-pause – silence just before the button appears.
· post-pause – silence after the button is pressed, before continuing.

Since the inside content is looped, any dynamic expressions (fades, beats) will repeat identically each loop.

---

<include src="filename.xml"/>

Includes the content of another XML file at this point in the document. The included file can contain any valid tags and expressions; its content is inlined at parse time before rendering.

Path is relative to the filesystem root (the app's data directory).

Included files may themselves contain `<include>` tags (recursive includes). Circular includes are silently skipped. Missing files are silently skipped.

The include is resolved before rendering, so all tags inside the included file behave exactly as if they were written inline.

---

3. Dynamic expressions

Expressions can be used anywhere "<expression>" is expected, and may be combined with +, -, *, /.

Fades & envelopes

Expression Description
@fadein(d) 0 → 1 over d (seconds or %)
@fadeout(d) 1 → 0 at the end
@fade(d) fade in + fade out
@ramp(start,end) linear ramp over whole duration
@env(attack,decay,sustain,release) ADSR envelope

Rhythmic & oscillators

Expression Description
@beat(bpm, [duty], [rise]) pulses 0–1
@sin(freq, [phase]) sine 0–1
@tri(freq, [duty]) triangle 0–1
@saw(freq) sawtooth 0–1
@noise(seed) pseudo‑random 0–1 (deterministic)

Utilities

Expression Description
@max(a,b), @min(a,b) min / max
@step(val, step) quantise to step
@round(val, decimals) round to decimals

---

4. Complete example (interactive + background)

```xml
<voice speaker="male" volume="@fadein(2)">
  <!-- background music for the whole introduction -->
  <tone type="noise" preset="pinknoise" volume="0.15"/>

  Welcome to the relaxation exercise.
  Press the button when you are ready to begin.
  <!-- an interactive pause with a soft heartbeat waiting sound -->
  <until button="I'm ready"
         waiting-sound="heart_beat"
         waiting-sound-volume="0.4"
         pre-pause="0.5"
         post-pause="0.3">
    Press the Button.
  </until>

  Now take a deep breath
  <background><sound type="swoosh" volume="0.4"/></background>
  and let it go slowly.
</voice>
```