Goal:
Here's a comprehensive developer-focused breakdown of voice feminization training:

| Parameter | Masculine Typical | Feminine Typical | Notes |
|---|---|---|---|
| **Fundamental Frequency (F0)** | 85–180 Hz | 165–265 Hz | Overlap zone: 165–180 Hz |
| **Formant 1 (F1)** | Lower | Higher | Tongue height affects this |
| **Formant 2 (F2)** | Lower | Higher | Tongue frontness |
| **Resonance space** | Larger, chest-dominated | Smaller, brighter/forward | Tract shortening illusion |
| **Intonation variance** | Narrow pitch range | Wider melodic range | Measured as F0 std dev |

---

### Exercises

#### 1. **Pitch Lifting (F0 Training)**
**Exercise**: Glide from a comfortable low pitch up to target range on a sustained vowel ("ahhh"). Hold at target for 5–10 seconds.
#### 2. **Resonance Shifting (Vocal Tract Tuning)**
 **Exercise**: "Witch voice" — constrict the throat slightly, raise the larynx, try to make the voice sound brighter/thinner without changing pitch. Hum while smiling.
#### 3. **Intonation & Melody Training**
**Exercise**: Read sentences with exaggerated pitch rises at the end of phrases. 
#### 4. **Breathiness & Voice Quality**
**Exercise**: Slightly breathy sustained vowels. Practice "soft onsets" — starting a sound gently rather than with a glottal stop.
#### 5. **Articulation & Mouth Space**
**Exercise**: Slightly over-enunciate consonants. Practice words with /s/, /ʃ/, /tʃ/ — these are spectrally sensitive and shift perception strongly.

#### 6. **Projection Without Weight**
- **Exercise**: Project voice forward (toward teeth/lips) rather than pushing from chest. Think "bright" not "loud."
voice/config.json (times in minutes, 0 disables)
```json
{
"pitchlift":{
"time":2,
"target_low":180,
"target_high":220
},
"resonance":{
"time":2
},
"intonation":{
"time":5
},
"breathiness":{
"time":2
},
"articulation":{
"time":2
},
"projection":{
"time":2
}
}
```