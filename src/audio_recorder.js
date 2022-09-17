'use strict';

/*
audio-recorder-polyfill license:

The MIT License (MIT)

Copyright 2017 Andrey Sitnik <andrey@sitnik.ru>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
const audioRecorderPolyfill = new function() {
  let pcm_s16leEncoder = function() {
    let buffers = []

    function encode(buffer) {
      let length = buffer.length
      let array = new Uint8Array(length * 2)
      let view = new DataView(array.buffer)
      for (let i = 0; i < length; i++) {
        let sample = Math.max(-32768, Math.min(32767, Math.floor(buffer[i] * 32768)))
        let byteOffset = i * 2
        view.setInt16(byteOffset, sample, true)
      }
      buffers.push(array)
    }

    function dump(maxOutputSize) {
      let outputBuffers = []
      let buffersPos = 0

      while (buffersPos < buffers.length) {
          let numBuffers = 0
          let length = 0

          while (buffersPos + numBuffers < buffers.length) {
              let buffer = buffers[buffersPos + numBuffers]
              if (numBuffers > 0 && length + buffer.length > maxOutputSize) {
                  break
              }
              ++numBuffers
              length += buffer.length
          }

          let array = new Uint8Array(length)
          let offset = 0

          for (let i = 0; i < numBuffers; ++i) {
              let buffer = buffers[buffersPos + i]
              array.set(buffer, offset)
              offset += buffer.length
          }

          buffersPos += numBuffers
          outputBuffers.push(array.buffer)
      }

      buffers = []

      return outputBuffers
    }

    onmessage = e => {
      var cmd = e.data[0];
      if (cmd === 'encode') {
        encode(e.data[1])
      } else if (cmd === 'dump') {
        let outputBuffers = dump(e.data[1])
        for (let i = 0; i < outputBuffers.length; ++i) {
            let buf = outputBuffers[i]
            postMessage(buf, [buf])
        }
      } else if (cmd === 'reset') {
        buffers = []
      }
    }
  }

  let AudioContext = window.AudioContext || window.webkitAudioContext

  function createWorker (fn) {
    let js = fn
      .toString()
      .replace(/^(\(\)\s*=>|function\s*\(\))\s*{/, '')
      .replace(/}$/, '')
    let blob = new Blob([js])
    return new Worker(URL.createObjectURL(blob))
  }
  
  function error (method) {
    let event = new Event('error')
    event.data = new Error('Wrong state for ' + method)
    return event
  }
  
  let context, processor
  
  /**
   * Audio Recorder with MediaRecorder API.
   *
   * @example
   * navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
   *   let recorder = new MediaRecorder(stream)
   * })
   */
  class MediaRecorder {
    /**
     * @param {MediaStream} stream The audio stream to record.
     */
    constructor (stream) {
      /**
       * The `MediaStream` passed into the constructor.
       * @type {MediaStream}
       */
      this.stream = stream
  
      /**
       * The current state of recording process.
       * @type {"inactive"|"recording"|"paused"}
       */
      this.state = 'inactive'
  
      this.em = document.createDocumentFragment()
      this.encoder = createWorker(MediaRecorder.encoder)
  
      let recorder = this
      this.encoder.addEventListener('message', e => {
        let event = new Event('dataavailable')
        event.data = e.data
        recorder.em.dispatchEvent(event)
        if (recorder.state === 'inactive') {
          recorder.em.dispatchEvent(new Event('stop'))
        }
      })
    }
  
    /**
     * Begins recording media.
     *
     * @param {number} [timeslice] The milliseconds to record into each `Blob`.
     *                             If this parameter isn’t included, single `Blob`
     *                             will be recorded.
     *
     * @return {undefined}
     *
     * @example
     * recordButton.addEventListener('click', () => {
     *   recorder.start()
     * })
     */
    start (timeslice, maxOutputSize) {
      if (this.state !== 'inactive') {
        return this.em.dispatchEvent(error('start'))
      }
  
      this.state = 'recording'
      this.maxOutputSize = maxOutputSize
  
      if (!context) {
        context = new AudioContext()
      }
      this.clone = this.stream.clone()
      this.input = context.createMediaStreamSource(this.clone)
  
      if (!processor) {
        processor = context.createScriptProcessor(2048, 1, 1)
      }
  
      let recorder = this
      processor.onaudioprocess = function (e) {
        if (recorder.state === 'recording') {
          recorder.encoder.postMessage([
            'encode', e.inputBuffer.getChannelData(0)
          ])
        }
      }
  
      this.input.connect(processor)
      processor.connect(context.destination)
  
      this.em.dispatchEvent(new Event('start'))
  
      if (timeslice) {
        this.slicing = setInterval(() => {
          if (recorder.state === 'recording') recorder.requestData()
        }, timeslice)
      }
  
      return undefined
    }

    getSampleRate() {
      return context.sampleRate
    }

    terminateWorker() {
      this.encoder.terminate();
    }
  
    /**
     * Stop media capture and raise `dataavailable` event with recorded data.
     *
     * @return {undefined}
     *
     * @example
     * finishButton.addEventListener('click', () => {
     *   recorder.stop()
     * })
     */
    stop () {
      if (this.state === 'inactive') {
        return this.em.dispatchEvent(error('stop'))
      }
  
      this.requestData()
      this.encoder.postMessage(['reset'])
      this.state = 'inactive'
      this.clone.getTracks().forEach(track => {
        track.stop()
      })
      this.clone = null
      processor.disconnect(context.destination)
      this.input.disconnect(processor)
      this.input = null
      return clearInterval(this.slicing)
    }
  
    /**
     * Raise a `dataavailable` event containing the captured media.
     *
     * @return {undefined}
     *
     * @example
     * this.on('nextData', () => {
     *   recorder.requestData()
     * })
     */
    requestData () {
      if (this.state === 'inactive') {
        return this.em.dispatchEvent(error('requestData'))
      }
  
      return this.encoder.postMessage(['dump', this.maxOutputSize])
    }
  
    /**
     * Add listener for specified event type.
     *
     * @param {"start"|"stop"|"pause"|"resume"|"dataavailable"|"error"}
     * type Event type.
     * @param {function} listener The listener function.
     *
     * @return {undefined}
     *
     * @example
     * recorder.addEventListener('dataavailable', e => {
     *   audio.src = URL.createObjectURL(e.data)
     * })
     */
    addEventListener (...args) {
      this.em.addEventListener(...args)
    }
  
    /**
     * Remove event listener.
     *
     * @param {"start"|"stop"|"pause"|"resume"|"dataavailable"|"error"}
     * type Event type.
     * @param {function} listener The same function used in `addEventListener`.
     *
     * @return {undefined}
     */
    removeEventListener (...args) {
      this.em.removeEventListener(...args)
    }
  
    /**
     * Calls each of the listeners registered for a given event.
     *
     * @param {Event} event The event object.
     *
     * @return {boolean} Is event was no canceled by any listener.
     */
    dispatchEvent (...args) {
      this.em.dispatchEvent(...args)
    }
  }
  
  /**
   * `true` if MediaRecorder can not be polyfilled in the current browser.
   * @type {boolean}
   *
   * @example
   * if (MediaRecorder.notSupported) {
   *   showWarning('Audio recording is not supported in this browser')
   * }
   */
  MediaRecorder.notSupported = !navigator.mediaDevices || !AudioContext
  
  /**
   * Converts RAW audio buffer to compressed audio files.
   * It will be loaded to Web Worker.
   * @type {function}
   */
  MediaRecorder.encoder = pcm_s16leEncoder
  
  this.MediaRecorder = MediaRecorder
}
export {
  audioRecorderPolyfill,
};
