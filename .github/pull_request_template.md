## What this changes

This PR fixes an issue in the Windows camera picker where the displayed camera name could be incorrect when the browser's camera device list and the Windows Media Foundation (MF) device list were enumerated in different orders.

### Problem

The application relies on two different sources of information to identify cameras:

- **Browser MediaDevices API:** Provides device IDs required to access and open the selected camera. However, camera labels may be unavailable or empty.
- **Windows Media Foundation:** Provides friendly names for native camera devices.

Previously, when a browser camera device did not have a label, the application used its list position to retrieve the corresponding name from the Media Foundation device list.

This approach was unreliable because both lists are enumerated independently, and their ordering is not guaranteed to be consistent. As a result, users could see an incorrect camera name in the picker, even though the application was using the correct browser device ID to access the camera.

### Solution

Updated the camera-name resolution logic to use the existing camera-matching mechanism instead of relying on list positions.

The updated behavior:

- Uses the browser-provided camera label whenever it is available.
- Uses the Media Foundation friendly name only when the existing camera matcher successfully identifies the corresponding device.
- Falls back to a generic label (e.g., `Camera 1`, `Camera 2`) when a reliable match cannot be established.
- Preserves the original browser device ID for opening and accessing the selected camera.

This ensures that the camera picker displays accurate device names whenever a reliable match is available and avoids presenting potentially misleading names when it is not.

**Scope:** This change only affects camera-name resolution and display in the Windows camera picker. It does not modify the underlying camera access or device-opening mechanism.

## How you tested it

### Environment
- **Operating System:** macOS
- **Validation:** Git diff whitespace and formatting check

### Checks performed

- Ran `git diff --check` to check for whitespace errors and formatting issues.
- The command completed successfully with no reported issues.

### Testing limitations

- The automated test suite was not executed.
- Windows-specific camera enumeration and Media Foundation behavior were not tested.
- Physical camera hardware and the camera-picker UI were not available for Windows validation.

Therefore, the code-level diff check passed, but the actual camera-picker behavior still requires verification on a Windows environment.

## Checklist

- [x] **One change per pull request:** This PR focuses exclusively on fixing camera-name matching in the Windows camera picker.
- [x] **Tests or a note on why none are needed:** Ran `git diff --check` successfully. The test suite was not run, and Windows-specific camera behavior remains unverified.
- [x] **Nothing new leaves the machine:** This change only affects how locally connected camera devices are identified and named. No additional data is transmitted externally.
- [x] **No telemetry, analytics or calls to a Clipy service:** This change introduces no telemetry, analytics, external service calls, or additional network communication.