'use strict';

import { audioRecorderPolyfill } from './audio_recorder.js';

const DefaultWebSocketUri = "wss://api.soniox.com/transcribe-websocket";
const DefaultApiKey = "demo";
const RecorderTimeSlice_ms = 100;
const MaxOutputSize_B = 60000;
const StatusMessageRegex = new RegExp("^<([a-zA-Z0-9_\\-]+)> *(([^ ]|$).*)$");

const State = Object.freeze({
  Init: "Init",
  RequestingMedia: "RequestingMedia",
  OpeningWebSocket: "OpeningWebSocket",
  Running: "Running",
  Finishing: "Finishing",
  FinishingEarly: "FinishingEarly",
  Finished: "Finished",
  Error: "Error",
  Canceled: "Canceled",
});

const ToUserStateMap = Object.freeze({
  "Init": "Init",
  "RequestingMedia": "Starting",
  "OpeningWebSocket": "Starting",
  "Running": "Running",
  "Finishing": "Finishing",
  "FinishingEarly": "Finishing",
  "Finished": "Finished",
  "Error": "Error",
  "Canceled": "Canceled",
});

function isInactiveState(state) {
  return state == State.Init ||
    state == State.Finished ||
    state == State.Error ||
    state == State.Canceled;
}

function isWebSocketState(state) {
  return state == State.OpeningWebSocket ||
    state == State.Running ||
    state == State.Finishing;
}

function wordFromJson(jsWord, isFinal) {
  return Object.freeze({
    text: jsWord.t,
    start_ms: jsWord.s,
    duration_ms: jsWord.d,
    is_final: isFinal,
  });
}

function resultFromResponse(response) {
  let words = [];
  response.fw.forEach(function (jsWord) {
    words.push(wordFromJson(jsWord, true));
  });
  response.nfw.forEach(function (jsWord) {
    words.push(wordFromJson(jsWord, false));
  });
  return Object.freeze({
    words: Object.freeze(words),
    final_proc_time_ms: response.fpt,
    total_proc_time_ms: response.tpt,
  });
}

function initialResult() {
  return {
    words: [],
    final_proc_time_ms: 0,
    total_proc_time_ms: 0,
  };
}

let recordTranscribeActive = false;

export class RecordTranscribe {
  constructor() {
    if (RecordTranscribe.notSupported) {
      throw "Soniox Web Voice is not supported on this browser.";
    }

    this._state = State.Init;
    this._includeNonFinal = false;
    this._apiKey = DefaultApiKey;
    this._speechContext = {};
    this._onStarted = null;
    this._onPartialResult = null;
    this._onFinished = null;
    this._onError = null;
    this._webSocketUri = DefaultWebSocketUri;
    this._mediaStream = null;
    this._mediaRecorder = null;
    this._mediaRecorderOnStop = null;
    this._mediaRecorderOnData = null;
    this._webSocket = null;
    this._result = initialResult();
  }

  setIncludeNonFinal(includeNonFinal) {
    if (this._state != State.Init) {
      throw "setIncludeNonFinal() may only be called before start()";
    }
    this._includeNonFinal = includeNonFinal;
  }

  setApiKey(apiKey) {
    if (this._state != State.Init) {
      throw "setApiKey() may only be called before start()";
    }
    this._apiKey = apiKey;
  }

  setSpeechContext(speechContext) {
    if (this._state != State.Init) {
      throw "setSpeechContext() may only be called before start()";
    }
    this._speechContext = speechContext;
  }

  setOnStarted(onStarted) {
    if (this._state != State.Init) {
      throw "setOnStarted() may only be called before start()";
    }
    this._onStarted = onStarted;
  }

  setOnPartialResult(onPartialResult) {
    if (this._state != State.Init) {
      throw "setOnPartialResult() may only be called before start()";
    }
    this._onPartialResult = onPartialResult;
  }

  setOnFinished(onFinished) {
    if (this._state != State.Init) {
      throw "setOnFinished() may only be called before start()";
    }
    this._onFinished = onFinished;
  }

  setOnError(onError) {
    if (this._state != State.Init) {
      throw "setOnError() may only be called before start()";
    }
    this._onError = onError;
  }

  setWebSocketUri(webSocketUri) {
    if (this._state != State.Init) {
      throw "setWebSocketUri() may only be called before start()";
    }
    this._webSocketUri = webSocketUri;
  }

  start() {
    if (this._state != State.Init) {
      throw "start() may only be called once";
    }
    if (recordTranscribeActive) {
      throw "only one RecordTranscribe may be active at a time";
    }
    const constraints = { audio: true };
    navigator.mediaDevices.getUserMedia(constraints).then(
      this._onGetUserMediaSuccess.bind(this),
      this._onGetUserMediaError.bind(this));
    recordTranscribeActive = true;
    this._state = State.RequestingMedia;
  }

  stop() {
    if (this._state == State.RequestingMedia ||
      this._state == State.OpeningWebSocket) {
      this._closeResources();
      Promise.resolve(true).then(this._completeFinishingEarly.bind(this));
      this._state = State.FinishingEarly;
    } else if (this._state == State.Running) {
      this._goRunningToFinishing();
    }
  }

  cancel() {
    if (!isInactiveState(this._state)) {
      this._closeResources();
      this._state = State.Canceled;
      recordTranscribeActive = false;
    }
  }

  getResult() {
    return this._result;
  }

  getResultCopy() {
    let result = this._result;
    return Object.freeze({
      words: Object.freeze(result.words.slice()),
      final_proc_time_ms: result.final_proc_time_ms,
      total_proc_time_ms: result.total_proc_time_ms,
    });
  }

  getState() {
    return ToUserStateMap[this._state];
  }

  _onGetUserMediaSuccess(mediaStream) {
    if (this._state != State.RequestingMedia) {
      mediaStream.getTracks().forEach(function (track) {
        track.stop();
      });
      return;
    }
    this._mediaStream = mediaStream;
    this._mediaRecorder = new audioRecorderPolyfill.MediaRecorder(mediaStream);
    this._mediaRecorderOnStop = this._onMediaRecorderStop.bind(this);
    this._mediaRecorderOnData = this._onMediaRecorderData.bind(this);
    this._mediaRecorder.addEventListener("stop", this._mediaRecorderOnStop);
    this._mediaRecorder.addEventListener("dataavailable", this._mediaRecorderOnData);
    this._webSocket = new WebSocket(this._webSocketUri);
    this._webSocket.onopen = this._onWebSocketOpen.bind(this);
    this._webSocket.onclose = this._onWebSocketClose.bind(this);
    this._webSocket.onerror = this._onWebSocketError.bind(this);
    this._webSocket.onmessage = this._onWebSocketMessage.bind(this);
    this._state = State.OpeningWebSocket;
  }

  _onGetUserMediaError() {
    if (this._state != State.RequestingMedia) {
      return;
    }
    this._handleError("get_user_media_failed", "Failed to get user media.");
  }

  _onMediaRecorderStop() {
    if (this._state != State.Running) {
      return;
    }
    this._goRunningToFinishing();
  }

  _onMediaRecorderData(event) {
    if (this._state != State.Running) {
      return;
    }
    this._webSocket.send(event.data);
  }

  _onWebSocketOpen(event) {
    if (this._state != State.OpeningWebSocket) {
      return;
    }
    this._mediaRecorder.start(RecorderTimeSlice_ms, MaxOutputSize_B);
    this._webSocket.send(JSON.stringify({
      api_key: this._apiKey,
      sample_rate_hertz: Math.round(this._mediaRecorder.getSampleRate()),
      include_nonfinal: this._includeNonFinal,
      speech_context: this._speechContext,
    }));
    this._state = State.Running;
    if (this._onStarted != null) {
      this._onStarted();
    }
  }

  _onWebSocketClose(event) {
    if (!isWebSocketState(this._state)) {
      return;
    }
    let status;
    let message;
    if (event.code == 1000) {
      const match = StatusMessageRegex.exec(event.reason);
      if (match != null) {
        status = match[1];
        message = match[2];
        if (status == "eof") {
          if (this._state == State.Finishing) {
            this._handleFinished();
            return;
          }
          status = "other_asr_error";
          message = "Unexpected EOF received.";
        }
      } else {
        status = "other_asr_error";
        message = event.reason;
      }
    } else {
      status = "websocket_closed";
      message = "WebSocket closed: code=" + event.code + ", reason=" + event.reason;
    }
    this._handleError(status, message);
  }

  _onWebSocketError(event) {
    if (!isWebSocketState(this._state)) {
      return;
    }
    this._handleError("websocket_error", "WebSocket error occurred.");
  }

  _onWebSocketMessage(event) {
    if (this._state != State.Running && this._state != State.Finishing) {
      return;
    }
    const response = JSON.parse(event.data);
    const result = resultFromResponse(response);
    this._updateResult(result);
    if (this._onPartialResult != null) {
      this._onPartialResult(result);
    }
  }

  _completeFinishingEarly(dummy) {
    if (this._state != State.FinishingEarly) {
      return;
    }
    this._handleFinished();
  }

  _closeResources() {
    this._closeWebSocket();
    this._closeMedia();
  }

  _closeWebSocket() {
    if (this._webSocket != null) {
      this._webSocket.onopen = null;
      this._webSocket.onclose = null;
      this._webSocket.onerror = null;
      this._webSocket.onmessage = null;
      this._webSocket.close();
      this._webSocket = null;
    }
  }

  _closeMedia() {
    if (this._mediaRecorder != null) {
      this._mediaRecorder.removeEventListener("stop", this._mediaRecorderOnStop);
      this._mediaRecorder.removeEventListener("dataavailable", this._mediaRecorderOnData);
      if (this._mediaRecorder.state != "inactive") {
        this._mediaRecorder.stop();
      }
      this._mediaRecorder.terminateWorker();
      this._mediaRecorderOnStop = null;
      this._mediaRecorderOnData = null;
      this._mediaRecorder = null;
    }
    if (this._mediaStream != null) {
      this._mediaStream.getTracks().forEach(function (track) {
        track.stop();
      });
      this._mediaStream = null;
    }
  }

  _goRunningToFinishing() {
    this._closeMedia();
    this._webSocket.send("");
    this._state = State.Finishing;
  }

  _handleError(status, message) {
    this._closeResources();
    this._state = State.Error;
    recordTranscribeActive = false;
    if (this._onError != null) {
      this._onError(status, message);
    }
  }

  _handleFinished() {
    this._closeResources();
    this._state = State.Finished;
    recordTranscribeActive = false;
    if (this._onFinished != null) {
      this._onFinished();
    }
  }

  _updateResult(newResult) {
    const result = this._result;
    const words = result.words;
    while (words.length > 0 && !words[words.length - 1].is_final) {
      words.pop();
    }
    newResult.words.forEach(function (word) {
      words.push(word);
    });
    result.final_proc_time_ms = newResult.final_proc_time_ms;
    result.total_proc_time_ms = newResult.total_proc_time_ms;
  }
}

RecordTranscribe.notSupported = (
  audioRecorderPolyfill.MediaRecorder.notSupported ||
  !navigator.mediaDevices.getUserMedia ||
  !WebSocket
);
