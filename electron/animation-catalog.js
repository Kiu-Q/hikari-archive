// Shared by the animation picker and settings. Asset parity is checked in tests.
export const VRMA_FILE_NAMES = [
    'hang.vrma', 'idle_airplane.vrma', 'idle_look.vrma', 'idle_loop.vrma',
    'idle_shoot.vrma', 'idle_sit.vrma', 'idle_sport.vrma', 'idle_stretch.vrma',
    'idle_vSign.vrma', 'idle_walk.vrma', 'lay.vrma', 'sit_down.vrma', 'sit_up.vrma',
    'start_1standUp.vrma', 'start_2turnAround.vrma',
    'walk_left.vrma', 'walk_right.vrma', 'wave_fast.vrma'
];

export const IDLE_VRMA_FILE_NAMES = VRMA_FILE_NAMES.filter(fileName => fileName.startsWith('idle'));
