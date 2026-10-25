#include <AudioToolbox/AudioHardwareService.h>
#include <CoreAudio/CoreAudio.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct {
  AudioObjectPropertySelector selector;
  AudioObjectPropertyScope scope;
  AudioObjectPropertyElement element;
} AudioScalarProperty;

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
  return status == noErr && size == sizeof(*value);
}

static int get_default_output_device(AudioObjectID *device_id) {
  uint32_t output_device = kAudioObjectUnknown;
  if (!read_uint32_property(
        kAudioObjectSystemObject,
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        &output_device) || output_device == kAudioObjectUnknown) {
    return 0;
  }

  *device_id = (AudioObjectID)output_device;
  return 1;
}

static int is_default_output_device(AudioObjectID device_id) {
  AudioObjectID current_device_id = kAudioObjectUnknown;
  return get_default_output_device(&current_device_id) &&
    current_device_id == device_id;
}

static AudioObjectPropertyAddress address_for(AudioScalarProperty property) {
  AudioObjectPropertyAddress address = {
    property.selector,
    property.scope,
    property.element
  };
  return address;
}

static int read_scalar(AudioObjectID device_id,
                       AudioScalarProperty property,
                       Float32 *value) {
  AudioObjectPropertyAddress address = address_for(property);
  if (!AudioObjectHasProperty(device_id, &address)) return 0;

  UInt32 size = sizeof(*value);
  OSStatus status = AudioObjectGetPropertyData(
    device_id,
    &address,
    0,
    NULL,
    &size,
    value
  );
  return status == noErr && size == sizeof(*value) && isfinite(*value);
}

static int scalar_is_settable(AudioObjectID device_id,
                              AudioScalarProperty property) {
  AudioObjectPropertyAddress address = address_for(property);
  Boolean is_settable = false;
  return AudioObjectHasProperty(device_id, &address) &&
    AudioObjectIsPropertySettable(device_id, &address, &is_settable) == noErr &&
    is_settable;
}

static int write_scalar(AudioObjectID device_id,
                        AudioScalarProperty property,
                        Float32 value) {
  AudioObjectPropertyAddress address = address_for(property);
  return AudioObjectSetPropertyData(
    device_id,
    &address,
    0,
    NULL,
    sizeof(value),
    &value
  ) == noErr;
}

static const AudioScalarProperty kVolumeProperties[] = {
  {
    kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
    kAudioDevicePropertyScopeOutput,
    kAudioObjectPropertyElementMain
  },
  {
    kAudioDevicePropertyVolumeScalar,
    kAudioDevicePropertyScopeOutput,
    kAudioObjectPropertyElementMain
  }
};

static int choose_volume_property(AudioObjectID device_id,
                                  int require_settable,
                                  AudioScalarProperty *selected,
                                  Float32 *current_value) {
  for (size_t i = 0; i < sizeof(kVolumeProperties) / sizeof(kVolumeProperties[0]); i++) {
    const AudioScalarProperty property = kVolumeProperties[i];
    Float32 value = 0;
    if (!read_scalar(device_id, property, &value)) continue;
    if (require_settable && !scalar_is_settable(device_id, property)) continue;

    *selected = property;
    *current_value = value;
    return 1;
  }
  return 0;
}

static int print_playback_status(void) {
  AudioObjectID output_device = kAudioObjectUnknown;
  if (!get_default_output_device(&output_device)) return 2;

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

static int print_volume(void) {
  AudioObjectID device_id = kAudioObjectUnknown;
  if (!get_default_output_device(&device_id)) {
    fputs("Unable to read the default output device.\n", stderr);
    return 2;
  }

  AudioScalarProperty property;
  Float32 value = 0;
  if (!choose_volume_property(device_id, 1, &property, &value)) {
    fputs("Default output device does not expose a readable, settable volume scalar.\n", stderr);
    return 3;
  }

  if (value < 0) value = 0;
  if (value > 1) value = 1;
  printf("%u %.6f\n", (unsigned int)device_id, (double)value);
  return 0;
}

/* macOS 14.2+ exposes audio processes without capturing their audio. */
static int print_playback_except(int excluded_count, char **excluded_pids) {
  const AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  if (!AudioObjectHasProperty(kAudioObjectSystemObject, &address)) {
    return print_playback_status();
  }
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr) return 3;
  if (size == 0) { puts("0"); return 0; }
  AudioObjectID *processes = malloc(size);
  if (!processes) return 3;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, processes) != noErr) {
    free(processes);
    return 3;
  }
  int playing = 0;
  for (size_t i = 0; i < size / sizeof(AudioObjectID); i++) {
    uint32_t pid = 0, running = 0;
    if (!read_uint32_property(processes[i], kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal, &pid)) continue;
    int excluded = 0;
    for (int j = 0; j < excluded_count; j++) {
      char *end = NULL;
      errno = 0;
      const unsigned long value = strtoul(excluded_pids[j], &end, 10);
      if (errno == 0 && end != excluded_pids[j] && *end == '\0' && value == pid) {
        excluded = 1;
        break;
      }
    }
    if (!excluded && read_uint32_property(processes[i], kAudioProcessPropertyIsRunningOutput,
        kAudioObjectPropertyScopeGlobal, &running) && running) {
      playing = 1;
      break;
    }
  }
  free(processes);
  puts(playing ? "1" : "0");
  return 0;
}

static int print_audio_state(void) {
  AudioObjectID device_id = kAudioObjectUnknown;
  if (!get_default_output_device(&device_id)) {
    puts("{\"available\":false}");
    return 0;
  }

  uint32_t is_running = 0;
  const int has_running = read_uint32_property(
    device_id,
    kAudioDevicePropertyDeviceIsRunningSomewhere,
    kAudioObjectPropertyScopeGlobal,
    &is_running
  );
  AudioScalarProperty volume_property;
  Float32 volume = 0;
  const int has_volume = choose_volume_property(device_id, 0, &volume_property, &volume);
  uint32_t muted_value = 0;
  const int has_mute = read_uint32_property(
    device_id,
    kAudioDevicePropertyMute,
    kAudioDevicePropertyScopeOutput,
    &muted_value
  );
  if (volume < 0) volume = 0;
  if (volume > 1) volume = 1;

  printf("{\"available\":true,\"deviceId\":%u,\"running\":%s,\"volume\":",
         (unsigned int)device_id,
         has_running && is_running ? "true" : "false");
  if (has_volume) printf("%.6f", (double)volume);
  else printf("null");
  printf(",\"muted\":");
  if (has_mute) printf("%s", muted_value ? "true" : "false");
  else printf("null");
  puts("}");
  return 0;
}

static int parse_device_id(const char *text, AudioObjectID *device_id) {
  if (text[0] == '-') return 0;

  errno = 0;
  char *end = NULL;
  unsigned long value = strtoul(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' ||
      value == kAudioObjectUnknown || value > UINT32_MAX) {
    return 0;
  }

  *device_id = (AudioObjectID)value;
  return 1;
}

static int parse_target(const char *text, Float32 *target) {
  errno = 0;
  char *end = NULL;
  double value = strtod(text, &end);
  if (errno != 0 || end == text || *end != '\0' || !isfinite(value)) return 0;

  if (value < 0) value = 0;
  if (value > 1) value = 1;
  *target = (Float32)value;
  return 1;
}

static int parse_duration(const char *text, unsigned long *duration_ms) {
  if (text[0] == '-') return 0;

  errno = 0;
  char *end = NULL;
  unsigned long value = strtoul(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value > 60000) return 0;

  *duration_ms = value;
  return 1;
}

static void sleep_for_ns(long nanoseconds) {
  struct timespec remaining = {
    nanoseconds / 1000000000L,
    nanoseconds % 1000000000L
  };
  while (nanosleep(&remaining, &remaining) != 0 && errno == EINTR) {
  }
}

static int ramp_volume(AudioObjectID device_id,
                       Float32 target,
                       unsigned long requested_duration_ms) {
  AudioScalarProperty property;
  Float32 start = 0;
  if (!choose_volume_property(device_id, 1, &property, &start)) {
    fputs("Default output device has no readable, settable volume scalar.\n", stderr);
    return 3;
  }
  if (!is_default_output_device(device_id)) {
    fputs("Default output device changed before the volume ramp started.\n", stderr);
    return 5;
  }

  if (start < 0) start = 0;
  if (start > 1) start = 1;
  if (start == target) return 0;

  /* Keep even a zero-duration request gradual, with at least two steps. */
  unsigned long duration_ms = requested_duration_ms < 20 ? 20 : requested_duration_ms;
  unsigned long step_count = (duration_ms + 9) / 10;
  if (step_count < 2) step_count = 2;
  long step_delay_ns = (long)((duration_ms * 1000000UL) / step_count);
  if (step_delay_ns <= 0) step_delay_ns = 10000000L;
  int ramp_has_written = 0;

  for (unsigned long step = 1; step <= step_count; step++) {
    sleep_for_ns(step_delay_ns);
    if (!is_default_output_device(device_id)) {
      if (ramp_has_written) {
        if (!write_scalar(device_id, property, start)) {
          fputs("Default output device changed during the volume ramp; unable to restore the previous device volume.\n", stderr);
          return 6;
        }
        fputs("Default output device changed during the volume ramp; restored the previous device volume.\n", stderr);
      } else {
        fputs("Default output device changed before the volume ramp wrote any changes.\n", stderr);
      }
      return 5;
    }

    Float32 fraction = (Float32)step / (Float32)step_count;
    Float32 value = start + (target - start) * fraction;
    if (step == step_count) value = target;

    if (!write_scalar(device_id, property, value)) {
      fputs("Unable to change the default output device volume.\n", stderr);
      return 4;
    }
    ramp_has_written = 1;
  }

  return 0;
}

static void print_usage(const char *program) {
  fprintf(stderr,
          "Usage: %s [audio-state | playing-except <pid>... | volume-get | volume-ramp <deviceId> <target-scalar> <duration-ms>]\n",
          program);
}

int main(int argc, char **argv) {
  if (argc == 1) return print_playback_status();
  if (argc >= 3 && strcmp(argv[1], "playing-except") == 0) {
    return print_playback_except(argc - 2, argv + 2);
  }

  if (argc == 2 && strcmp(argv[1], "volume-get") == 0) {
    return print_volume();
  }
  if (argc == 2 && strcmp(argv[1], "audio-state") == 0) {
    return print_audio_state();
  }
  if (argc == 5 && strcmp(argv[1], "volume-ramp") == 0) {
    AudioObjectID device_id = kAudioObjectUnknown;
    Float32 target = 0;
    unsigned long duration_ms = 0;
    if (!parse_device_id(argv[2], &device_id) ||
        !parse_target(argv[3], &target) ||
        !parse_duration(argv[4], &duration_ms)) {
      print_usage(argv[0]);
      return 64;
    }
    return ramp_volume(device_id, target, duration_ms);
  }

  print_usage(argv[0]);
  return 64;
}
