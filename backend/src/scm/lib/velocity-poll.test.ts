import { describe, expect, it } from 'vitest';
import { parseDevices } from './velocity-poll';

// Shape from the live call on 14 Oct 2026 (customer 33342001, one tracker).
const dev = {
  id: 1160441, vehicle_registration: 'VRH 9058', lat: 2.703637, lon: 101.886634,
  speed: 0, speed_measure_text: 'KM/H', direction: 317.0, ignition: 'Y',
  street: 'Jalan Saujana Indah 2', town: 'Seremban', timestamp: '1791968775',
};

describe('parseDevices', () => {
  it('maps a Velocity device to a fix with a normalized plate and ISO time', () => {
    expect(parseDevices({ devices: [dev] })).toEqual([{
      deviceId: '1160441', plate: 'VRH9058', lat: 2.703637, lng: 101.886634,
      speedKmh: 0, heading: 317, ignition: true,
      street: 'Jalan Saujana Indah 2, Seremban',
      recordedAt: new Date(1791968775 * 1000).toISOString(),
    }]);
  });

  it('converts MPH to km/h', () => {
    expect(parseDevices({ devices: [{ ...dev, speed: 10, speed_measure_text: 'MPH' }] })[0].speedKmh).toBeCloseTo(16.09, 2);
  });

  it('drops devices with no plate, no position, a bad position or no time', () => {
    const bad = [
      { ...dev, vehicle_registration: '' },
      { ...dev, lat: null },
      { ...dev, lat: 99.9999999 },
      { ...dev, timestamp: undefined },
    ];
    expect(parseDevices({ devices: bad })).toEqual([]);
    expect(parseDevices(null)).toEqual([]);
  });
});
