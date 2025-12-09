# Draw Steel Damage Fix

A Foundry VTT module that enables collaborative damage application in the Draw Steel system through a secure GM relay mechanism.

## Overview

The Draw Steel system by default prevents players from applying damage to NPC tokens they don't own. This module solves that limitation by:

- Providing a socket-based communication channel for damage requests
- Maintaining GM control over damage application
- Adding smart validation and confirmation dialogs
- Supporting both automatic and manual approval modes

## Features

### Core Functionality
- **Socket-based damage relay**: Players can request damage application to any token
- **GM approval system**: Configurable auto-apply or manual approval
- **Smart confirmation dialogs**:
  - Self-damage warnings
  - Hostile healing warnings
  - Multi-target damage confirmations
- **Audit logging**: Transparent logging of all damage requests and applications
- **Session validation**: Basic security to prevent abuse

### Configuration Options

All settings are available in **Game Settings → Module Settings → Draw Steel Damage Fix**:

| Setting | Description | Default |
|---------|-------------|---------|
| **GM Approval Mode** | Auto-apply or require manual approval | Auto-Apply |
| **Confirmation Threshold** | Always confirm when damaging N+ targets | 2 |
| **Smart Prompts** | Enable self-damage and hostile healing warnings | Enabled |
| **Audit Logging** | Log requests and applications to console | Enabled |

## Installation

### Prerequisites

**⚠️ SocketLib is REQUIRED**

This module requires **SocketLib** to function and will not load without it:

1. Install SocketLib from the Foundry VTT module marketplace or from:
   - GitHub: https://github.com/farling42/foundryvtt-socketlib
   - Foundry Package: https://foundryvtt.com/packages/socketlib
2. **Enable SocketLib** in your World Settings → Module Management
3. Ensure SocketLib is active before enabling this module

### Manual Installation (Required)

1. **Install SocketLib first** (see prerequisites above)
2. **Download the module files** to your local machine
3. **Copy the entire module folder** to your Foundry VTT `Data/modules/` directory
4. **Restart the Foundry server** if it's currently running
5. **Enable SocketLib** in Module Management (if not already enabled)
6. **Enable this module** in Module Management
7. **Configure settings** as desired in Game Settings

**Important:** The module will throw an error during loading if SocketLib is not installed and activated.

### Module Structure
```
draw-steel-damage-fix/
├── scripts/
│   └── damage-fix.mjs      # Main module logic
├── module.json             # Foundry manifest
├── README.md              # This file
├── LICENSE                # MIT license
└── .gitignore            # Git ignore rules
```

## Usage

### For Players

1. **Normal damage application**: Works as usual for tokens you own
2. **Damage to unowned NPCs**:
   - Click to apply damage as normal
   - Request is automatically sent to the GM
   - You'll receive a notification that the request was sent
   - Damage will be applied based on GM's approval mode

### For Game Masters

#### Auto-Apply Mode (Default)
- Damage requests are automatically applied
- You'll receive notifications about each application
- Full audit trail in the console

#### Manual Approval Mode
- Each damage request triggers an approval dialog
- Dialog shows:
  - Requesting player name
  - Target token and damage amount
  - Number of targets
  - Request timestamp
- Choose to **Approve** or **Deny** each request

## Security Considerations

This module implements basic security measures:

- **Session validation**: Only authenticated users can send requests
- **GM authority**: Only GM can apply damage to unowned tokens
- **Request logging**: All actions are logged for transparency
- **Input validation**: Damage requests are validated before processing

### Recommendations

- Enable audit logging for transparency
- Use manual approval mode in public games or with unfamiliar players
- Review console logs periodically for unusual activity

## Troubleshooting

### Common Issues

**Module not loading**
- Ensure the module folder is correctly placed in `Data/modules/`
- Check that Foundry server was restarted after installation
- Verify the module is enabled in World Settings

**Damage requests not working**
- Confirm the GM is online and has the module enabled
- Check browser console for error messages
- Verify socket connections are working (try refreshing)

**Settings not saving**
- Ensure you have GM permissions to change world settings
- Check that the module is properly loaded (look for console message on startup)

### Debug Mode

Enable audit logging to see detailed information in the browser console:
1. Go to Game Settings → Module Settings → Draw Steel Damage Fix
2. Ensure "Enable Audit Logging" is checked
3. Open browser console (F12) and filter for "draw-steel-damage-fix"

## Compatibility

- **Foundry VTT**: Version 0.8.0 and later
- **Draw Steel System**: All versions
- **Other modules**: Designed to be compatible with most damage-related modules

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This module is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Changelog

### Version 1.0.0
- Initial release
- Socket-based damage relay system
- GM approval modes (auto/manual)
- Smart confirmation dialogs
- Audit logging functionality
- Configuration UI

## Support

For issues, questions, or feature requests:
- Create an issue on the GitHub repository
- Join the Draw Steel community Discord
- Check the troubleshooting section above