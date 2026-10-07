#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/AudioHardwareTapping.h>
#include <stdatomic.h>
#include <math.h>
#include <signal.h>
#include <unistd.h>

// The audio callback retains only these two scalars; PCM never leaves it.
static _Atomic float latestLevel = 0, latestBass = 0;
static _Atomic unsigned long frameCount = 0;
static double lowpass = 0;
static AudioObjectID tap = kAudioObjectUnknown, aggregate = kAudioObjectUnknown;
static AudioDeviceIOProcID ioProc = NULL;
static CATapDescription *description;
static NSMutableSet<NSNumber *> *excludedPids;

static void emit(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}

static void analyse(const float *samples, size_t count, double sampleRate) {
  if (!count) return;
  const double alpha = 1 - exp(-2 * M_PI * 160 / sampleRate);
  double energy = 0, bassEnergy = 0;
  for (size_t i = 0; i < count; i++) {
    const double sample = isfinite(samples[i]) ? samples[i] : 0;
    lowpass += alpha * (sample - lowpass);
    energy += sample * sample;
    bassEnergy += lowpass * lowpass;
  }
  atomic_store(&latestLevel, (float)sqrt(energy / count));
  atomic_store(&latestBass, (float)sqrt(bassEnergy / count));
  atomic_fetch_add(&frameCount, 1);
}

static NSArray<NSNumber *> *excludedProcesses(void) {
  AudioObjectPropertyAddress address = { kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr || !size) return @[];
  NSMutableData *data = [NSMutableData dataWithLength:size];
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, data.mutableBytes) != noErr) return @[];
  AudioObjectID *objects = data.mutableBytes;
  NSMutableArray *result = [NSMutableArray array];
  for (size_t i = 0; i < size / sizeof(AudioObjectID); i++) {
    UInt32 pid = 0, pidSize = sizeof(pid);
    AudioObjectPropertyAddress pidAddress = { kAudioProcessPropertyPID,
      kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(objects[i], &pidAddress, 0, NULL, &pidSize, &pid) == noErr &&
        [excludedPids containsObject:@(pid)]) [result addObject:@(objects[i])];
  }
  return result;
}

static void cleanup(void) {
  if (aggregate != kAudioObjectUnknown) {
    if (ioProc) { AudioDeviceStop(aggregate, ioProc); AudioDeviceDestroyIOProcID(aggregate, ioProc); }
    AudioHardwareDestroyAggregateDevice(aggregate);
  }
  if (@available(macOS 14.2, *)) {
    if (tap != kAudioObjectUnknown) AudioHardwareDestroyProcessTap(tap);
  }
  ioProc = NULL; aggregate = tap = kAudioObjectUnknown;
}

static int fail(NSString *stage, OSStatus status) {
  emit(@{ @"type": @"error", @"stage": stage, @"status": @(status) });
  cleanup(); return 1;
}

static int fixture(void) {
  // Known 120-BPM bass pulses pass through the same PCM analyser as the tap.
  const int count = 1920;
  float samples[count];
  for (int frame = 0; frame < 150; frame++) {
    for (int i = 0; i < count; i++) {
      const double t = (frame * count + i) / 48000.0;
      const double phase = fmod(t, 0.5);
      const double amplitude = phase < 0.10 ? 0.12 * exp(-phase * 30) : 0;
      samples[i] = amplitude * sin(2 * M_PI * 80 * t);
    }
    analyse(samples, count, 48000);
    emit(@{ @"type": @"frame", @"level": @(atomic_load(&latestLevel)),
      @"bass": @(atomic_load(&latestBass)), @"timeMs": @(frame * 40) });
  }
  return 0;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return fixture();
    if (@available(macOS 14.2, *)) {
      excludedPids = [NSMutableSet setWithObject:@(getpid())];
      for (int i = 1; i < argc; i++) [excludedPids addObject:@(strtol(argv[i], NULL, 10))];
      description = [[CATapDescription alloc] initMonoGlobalTapButExcludeProcesses:excludedProcesses()];
      description.name = @"Hikari music beat analysis";
      description.privateTap = YES;
      description.muteBehavior = CATapUnmuted;
      OSStatus status = AudioHardwareCreateProcessTap(description, &tap);
      if (status != noErr) return fail(@"tap", status);
      AudioStreamBasicDescription format = {0};
      UInt32 size = sizeof(format);
      AudioObjectPropertyAddress formatAddress = { kAudioTapPropertyFormat,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
      status = AudioObjectGetPropertyData(tap, &formatAddress, 0, NULL, &size, &format);
      if (status != noErr || !(format.mFormatFlags & kAudioFormatFlagIsFloat) ||
          format.mBitsPerChannel != 32 || format.mChannelsPerFrame != 1 || format.mSampleRate <= 0) return fail(@"format", status);
      NSDictionary *device = @{
        @kAudioAggregateDeviceNameKey: @"Hikari private music analyser",
        @kAudioAggregateDeviceUIDKey: NSUUID.UUID.UUIDString,
        @kAudioAggregateDeviceIsPrivateKey: @YES,
        @kAudioAggregateDeviceTapAutoStartKey: @YES,
        @kAudioAggregateDeviceTapListKey: @[@{
          @kAudioSubTapUIDKey: description.UUID.UUIDString,
          @kAudioSubTapDriftCompensationKey: @YES
        }]
      };
      status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)device, &aggregate);
      if (status != noErr) return fail(@"device", status);
      status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, NULL,
        ^(const AudioTimeStamp *now, const AudioBufferList *input, const AudioTimeStamp *inputTime,
          AudioBufferList *output, const AudioTimeStamp *outputTime) {
          (void)now; (void)inputTime; (void)output; (void)outputTime;
          if (input->mNumberBuffers && input->mBuffers[0].mData) {
            analyse(input->mBuffers[0].mData, input->mBuffers[0].mDataByteSize / sizeof(float), format.mSampleRate);
          }
        });
      if (status != noErr) return fail(@"callback", status);
      status = AudioDeviceStart(aggregate, ioProc);
      if (status != noErr) return fail(@"start", status);
      signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN);
      dispatch_source_t term = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
      dispatch_source_set_event_handler(term, ^{ cleanup(); exit(0); }); dispatch_resume(term);
      dispatch_source_t interrupt = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, dispatch_get_main_queue());
      dispatch_source_set_event_handler(interrupt, ^{ cleanup(); exit(0); }); dispatch_resume(interrupt);
      dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
      dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), 40 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
      __block unsigned long previousCount = 0;
      __block int ticks = 0;
      dispatch_source_set_event_handler(timer, ^{
        const unsigned long count = atomic_load(&frameCount);
        const BOOL fresh = count != previousCount; previousCount = count;
        emit(@{ @"type": @"frame", @"level": fresh ? @(atomic_load(&latestLevel)) : @0,
          @"bass": fresh ? @(atomic_load(&latestBass)) : @0 });
        // Refresh exclusions after new Hikari audio processes appear.
        if (++ticks % 25 == 0) {
          description.processes = excludedProcesses();
          AudioObjectPropertyAddress address = { kAudioTapPropertyDescription,
            kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
          CATapDescription *updated = description;
          AudioObjectSetPropertyData(tap, &address, 0, NULL, sizeof(updated), &updated);
        }
      });
      // A small stdin control protocol updates excluded process IDs. EOF means
      // the owning Electron app exited, so release the tap immediately.
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        char *line = NULL; size_t capacity = 0;
        while (getline(&line, &capacity, stdin) > 0) {
          NSData *data = [NSData dataWithBytes:line length:strlen(line)];
          id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
          if ([value isKindOfClass:NSArray.class]) {
            NSMutableSet *next = [NSMutableSet setWithObject:@(getpid())];
            for (id pid in value) if ([pid isKindOfClass:NSNumber.class]) [next addObject:pid];
            dispatch_async(dispatch_get_main_queue(), ^{ excludedPids = next; });
          }
        }
        free(line); dispatch_async(dispatch_get_main_queue(), ^{ cleanup(); exit(0); });
      });
      emit(@{ @"type": @"ready" }); dispatch_resume(timer);
      [[NSRunLoop mainRunLoop] run];
      cleanup(); return 0;
    }
    emit(@{ @"type": @"error", @"stage": @"unsupported", @"status": @0 }); return 1;
  }
}
