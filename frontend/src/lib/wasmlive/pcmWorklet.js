/**
 * Plays interleaved stereo float chunks and reports what it has rendered.
 *
 * That report is the clock the whole pipeline runs on, so it counts frames
 * actually written to the output — not frames received, and not wall time.
 * Video is presented against it, which is why lip sync holds without anything
 * correcting for drift.
 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[]} interleaved stereo, oldest first */
    this.queue = [];
    this.offset = 0;
    this.rendered = 0;
    this.port.onmessage = (event) => {
      if (event.data === null) {
        // A seek: drop what was queued rather than playing the old position.
        this.queue = [];
        this.offset = 0;
        return;
      }
      this.queue.push(event.data);
    };
  }

  process(_inputs, outputs) {
    this.calls = (this.calls || 0) + 1;
    // A heartbeat that does not depend on there being audio to play: without
    // it, "the clock stopped" and "the processor stopped" look identical from
    // the page, and they have completely different causes.
    if (this.calls % 100 === 0) {
      this.port.postMessage({ calls: this.calls, queued: this.queue.length });
    }

    const left = outputs[0][0];
    const right = outputs[0][1] ?? outputs[0][0];

    for (let i = 0; i < left.length; i++) {
      const chunk = this.queue[0];
      if (!chunk) {
        // Underrun: silence rather than a repeat, and the clock does not
        // advance, so video holds its last field instead of running ahead.
        left[i] = 0;
        right[i] = 0;
        continue;
      }
      left[i] = chunk[this.offset];
      right[i] = chunk[this.offset + 1];
      this.offset += 2;
      this.rendered++;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    // One message per render quantum would be 375 a second at 48kHz. Ten a
    // second is plenty for a clock that video reads every frame.
    if (this.rendered >= 4800) {
      this.port.postMessage(this.rendered);
      this.rendered = 0;
    }
    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
