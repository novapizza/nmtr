import { describe, it, expect } from 'vitest'
import { parseArpOutput, parseHardwarePorts } from '../src/main/lan/LanScanner'
import {
  parseSystemProfilerWifi,
  parseSpChannel,
  parseSpSecurity,
  dbmToPercent
} from '../src/main/wifi/macWifiParser'

describe('parseArpOutput', () => {
  it('parses macOS arp -an with leading zeros dropped', () => {
    const out = [
      '? (169.254.169.254) at (incomplete) on en0 [ethernet]',
      '? (192.168.50.1) at cc:28:aa:5e:37:b4 on en0 ifscope [ethernet]',
      '? (192.168.50.90) at c:5d:89:2b:f1:8 on en0 ifscope [ethernet]',
      '? (192.168.50.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]'
    ].join('\n')
    expect(parseArpOutput(out)).toEqual([
      { ip: '192.168.50.1', mac: 'cc:28:aa:5e:37:b4' },
      { ip: '192.168.50.90', mac: '0c:5d:89:2b:f1:08' }
    ])
  })

  it('still parses Windows arp -a', () => {
    const out = '  192.168.1.1           aa-bb-cc-dd-ee-0f     dynamic\r\n'
    expect(parseArpOutput(out)).toEqual([{ ip: '192.168.1.1', mac: 'aa:bb:cc:dd:ee:0f' }])
  })
})

describe('parseHardwarePorts', () => {
  it('maps BSD device names to hardware ports', () => {
    const out = [
      'Hardware Port: Wi-Fi', 'Device: en0', 'Ethernet Address: 9a:db:f8:bf:95:51', '',
      'Hardware Port: Thunderbolt Bridge', 'Device: bridge0', 'Ethernet Address: N/A'
    ].join('\n')
    const map = parseHardwarePorts(out)
    expect(map.get('en0')).toBe('Wi-Fi')
    expect(map.get('bridge0')).toBe('Thunderbolt Bridge')
  })
})

describe('macOS Wi-Fi (system_profiler)', () => {
  it('parses channel strings into channel + band', () => {
    expect(parseSpChannel('52 (5GHz, 160MHz)')).toEqual({ channel: 52, band: '5 GHz' })
    expect(parseSpChannel('6 (2GHz, 20MHz)')).toEqual({ channel: 6, band: '2.4 GHz' })
    expect(parseSpChannel('37 (6GHz, 320MHz)')).toEqual({ channel: 37, band: '6 GHz' })
    expect(parseSpChannel('149')).toEqual({ channel: 149, band: '5 GHz' })
  })

  it('maps security modes, including the "pairport" typo', () => {
    expect(parseSpSecurity('spairport_security_mode_wpa2_personal')).toBe('WPA2-Personal')
    expect(parseSpSecurity('pairport_security_mode_wpa3_transition')).toBe('WPA2/WPA3-Personal')
    expect(parseSpSecurity('spairport_security_mode_none')).toBe('Open')
    expect(parseSpSecurity(undefined)).toBeNull()
  })

  it('converts dBm to a 0–100 percentage', () => {
    expect(dbmToPercent(-50)).toBe(100)
    expect(dbmToPercent(-75)).toBe(50)
    expect(dbmToPercent(-110)).toBe(0)
    expect(dbmToPercent(null)).toBeNull()
  })

  const sample = JSON.stringify({
    SPAirPortDataType: [{
      spairport_airport_interfaces: [
        {
          _name: 'en0',
          spairport_status_information: 'spairport_status_connected',
          spairport_current_network_information: {
            _name: '<redacted>',
            spairport_network_channel: '52 (5GHz, 160MHz)',
            spairport_network_phymode: '802.11ax',
            spairport_network_rate: 2041,
            spairport_security_mode: 'pairport_security_mode_wpa3_transition',
            spairport_signal_noise: '-55 dBm / -91 dBm'
          },
          spairport_airport_other_local_wireless_networks: [
            { _name: '<redacted>', spairport_network_channel: '6 (2GHz, 20MHz)', spairport_security_mode: 'spairport_security_mode_wpa2_personal' },
            { _name: '<redacted>', spairport_network_channel: '52 (5GHz, 160MHz)', spairport_security_mode: 'pairport_security_mode_wpa3_transition', spairport_signal_noise: '-45 dBm / -91 dBm' }
          ]
        },
        { _name: 'awdl0', spairport_current_network_information: {} }
      ]
    }]
  })

  it('parses the current connection and nearby networks', () => {
    const r = parseSystemProfilerWifi(sample)
    expect(r.interfaceFound).toBe(true)
    expect(r.ssidsRedacted).toBe(true)
    expect(r.connection).toMatchObject({
      interfaceName: 'Wi-Fi (en0)', state: 'connected', ssid: null, band: '5 GHz',
      channel: 52, rssiDbm: -55, signalPercent: 90, txRateMbps: 2041, authentication: 'WPA2/WPA3-Personal'
    })
    expect(r.networks).toHaveLength(2)
    // Our AP is matched in the scan list (unique channel+security) and floats to the top.
    expect(r.networks[0]).toMatchObject({ channel: 52, isCurrent: true, rssiDbm: -45 })
    expect(r.networks[1]).toMatchObject({ channel: 6, isCurrent: false, rssiDbm: null, band: '2.4 GHz' })
  })

  it('reports no interface for empty / invalid output', () => {
    expect(parseSystemProfilerWifi('{"SPAirPortDataType":[{}]}').interfaceFound).toBe(false)
    expect(parseSystemProfilerWifi('not json').interfaceFound).toBe(false)
  })
})
