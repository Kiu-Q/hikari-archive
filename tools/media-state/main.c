#include <CoreAudio/CoreAudio.h>
#include <stdint.h>
#include <stdio.h>

static int read_uint32_property(AudioObjectID object_id,
                                AudioObjectPropertySelector selector,
                                AudioObjectPropertyScope scope,
                                uint32_t *value) {
  AudioObjectPropertyAddress address = {
    selector,
    scope,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = sizeof(*value);
  OSStatus status = AudioObjectGetPropertyData(
    object_id,
    &address,
    0,
    NULL,
    &size,
    value
  );
  return status == noErr;
}

int main(void) {
  uint32_t output_device = kAudioObjectUnknown;
  if (!read_uint32_property(
        kAudioObjectSystemObject,
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        &output_device) || output_device == kAudioObjectUnknown) {
    return 2;
  }

  uint32_t is_running = 0;
  if (!read_uint32_property(
        output_device,
        kAudioDevicePropertyDeviceIsRunningSomewhere,
        kAudioObjectPropertyScopeGlobal,
        &is_running)) {
    return 3;
  }

  puts(is_running ? "1" : "0");
  return 0;
}
