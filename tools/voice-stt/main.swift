import Foundation
import Speech
import AVFoundation

func emit(_ payload: [String: Any], status: Int32) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(status)
}

func uint32LE(_ data: Data, _ offset: Int) -> UInt32 {
    guard offset + 4 <= data.count else { return 0 }
    return UInt32(data[offset]) | UInt32(data[offset + 1]) << 8 | UInt32(data[offset + 2]) << 16 | UInt32(data[offset + 3]) << 24
}

func uint16LE(_ data: Data, _ offset: Int) -> UInt16 {
    guard offset + 2 <= data.count else { return 0 }
    return UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
}

func wavSamples(_ data: Data) -> [Float]? {
    guard data.count >= 44, String(data: data[0..<4], encoding: .ascii) == "RIFF", String(data: data[8..<12], encoding: .ascii) == "WAVE" else { return nil }
    let sampleRate = uint32LE(data, 24)
    let channels = uint16LE(data, 22)
    let bits = uint16LE(data, 34)
    guard sampleRate == 16000, channels == 1, bits == 16 else { return nil }
    var offset = 12
    while offset + 8 <= data.count {
        let name = String(data: data[offset..<offset + 4], encoding: .ascii) ?? ""
        let length = Int(uint32LE(data, offset + 4))
        let start = offset + 8
        guard length >= 0, start + length <= data.count else { return nil }
        if name == "data" {
            var samples = [Float]()
            samples.reserveCapacity(length / 2)
            var index = start
            while index + 1 < start + length {
                let bits = uint16LE(data, index)
                samples.append(Float(Int16(bitPattern: bits)) / 32768.0)
                index += 2
            }
            return samples
        }
        offset = start + length + (length % 2)
    }
    return nil
}

let arguments = CommandLine.arguments
var localeIdentifier = ProcessInfo.processInfo.environment["HIKARI_STT_LOCALE"] ?? Locale.current.identifier
if let flag = arguments.firstIndex(of: "--locale"), flag + 1 < arguments.count {
    localeIdentifier = arguments[flag + 1]
}

let wav = FileHandle.standardInput.readDataToEndOfFile()
guard var samples = wavSamples(wav), samples.count >= 1600, samples.count <= 1_600_000 else {
    emit(["error": "invalid_audio_segment"], status: 2)
}
defer {
    samples.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
}

let authorizationSemaphore = DispatchSemaphore(value: 0)
var authorization = SFSpeechRecognizer.authorizationStatus()
if authorization == .notDetermined {
    SFSpeechRecognizer.requestAuthorization { authorization = $0; authorizationSemaphore.signal() }
    _ = authorizationSemaphore.wait(timeout: .now() + 30)
}
guard authorization == .authorized else { emit(["error": "speech_permission_\(authorization.rawValue)"], status: 3) }
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)), recognizer.isAvailable else {
    emit(["error": "speech_recognizer_unavailable", "locale": localeIdentifier], status: 4)
}
guard recognizer.supportsOnDeviceRecognition else {
    emit(["error": "on_device_recognition_unavailable", "locale": localeIdentifier], status: 5)
}
guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
      let channel = buffer.floatChannelData?[0] else {
    emit(["error": "audio_buffer_unavailable"], status: 6)
}
buffer.frameLength = AVAudioFrameCount(samples.count)
for index in samples.indices { channel[index] = samples[index] }

let request = SFSpeechAudioBufferRecognitionRequest()
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = false
request.append(buffer)
request.endAudio()
let resultSemaphore = DispatchSemaphore(value: 0)
var transcript = ""
var recognitionError: String?
let task = recognizer.recognitionTask(with: request) { result, error in
    if let result, result.isFinal { transcript = result.bestTranscription.formattedString; resultSemaphore.signal() }
    else if let error { recognitionError = error.localizedDescription; resultSemaphore.signal() }
}
let waitResult = resultSemaphore.wait(timeout: .now() + 40)
if waitResult == .timedOut { task.cancel(); emit(["error": "recognition_timeout"], status: 7) }
if let recognitionError { emit(["error": recognitionError], status: 8) }
emit(["text": transcript, "locale": localeIdentifier, "onDevice": true], status: 0)
