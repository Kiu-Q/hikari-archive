# FBX to VRMA Converter

## 🧠 TPMJS Tool Registry & AI Agent Use

This package is discoverable and usable by AI agents and tool runners via the [TPMJS Tool Registry](https://tpmjs.com/). To use in AI workflows, simply install from npm and invoke the CLI or import as a Node.js module. For more, see [tpmjs.com](https://tpmjs.com/).

**To publish as a TPMJS tool:**
- Ensure the `tpmjs-tool` keyword is in your `package.json` (already included)
- Publish to npm: `npm publish`
- Your tool will appear on tpmjs.com within 15 minutes

For best AI compatibility, keep your CLI and API usage clear and documented. See [TPMJS publishing guide](https://tpmjs.com/publish) for more info.

Convert FBX animation files to VRMA (VRM Animation) format for use with VRM models in web applications.

English README | [日本語 README](README-jp.md)

## 🎯 Features

- **🎬 FBX to VRMA Conversion**: Convert FBX animations to VRMA format
- **🎭 Mixamo Support**: Automatic bone mapping for Mixamo animations
- **🔧 Embedded Buffers**: No external dependencies required
- **✅ VRM Compatible**: Full compatibility with @pixiv/three-vrm-animation
- **🧪 Validation Tools**: Built-in validation and testing

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- macOS, Windows, or Linux
- FBX2glTF binary (see installation below)

### Installation

#### 1. Clone the Repository

```bash
git clone https://github.com/tk256ailab/fbx2vrma-converter.git
cd fbx2vrma-converter
npm install
./setup.sh  # Download FBX2glTF binary
```

#### 2. Download FBX2glTF Binary

**Method 1: Automatic Setup (Recommended)**

Run the setup script to automatically download the correct binary for your platform:

```bash
# macOS/Linux
./setup.sh

# Windows (Command Prompt)
setup.bat

# Windows (PowerShell)
.\setup.bat
```

**Method 2: Manual Download**

If the setup script fails, manually download the binary:

1. Go to [FBX2glTF Releases](https://github.com/facebookincubator/FBX2glTF/releases)
2. Click on the latest release (v0.9.7)
3. Download the appropriate binary:
   - macOS: `FBX2glTF-darwin-x64`
   - Windows: `FBX2glTF-windows-x64.exe`
   - Linux: `FBX2glTF-linux-x64`
4. Place the binary in your project directory
5. Make it executable (macOS/Linux): `chmod +x FBX2glTF-darwin-x64`

#### 3. Verify Installation

```bash
# Test the binary works
./FBX2glTF-darwin-x64 --help   # macOS
./FBX2glTF-windows-x64.exe --help   # Windows
./FBX2glTF-linux-x64 --help    # Linux
```

### Basic Usage

```bash
# Convert an FBX file to VRMA
node fbx2vrma-converter.js -i input.fbx -o output.vrma

# With custom framerate
node fbx2vrma-converter.js -i input.fbx -o output.vrma --framerate 60
```

### Example

```bash
# Convert Mixamo animation
node fbx2vrma-converter.js -i examples/SittingLaughing.fbx -o SittingLaughing.vrma
```

## 📋 Command Line Options

```
Options:
  -i, --input <path>      Input FBX file path (required)
  -o, --output <path>     Output VRMA file path (required)
  --fbx2gltf <path>       Path to FBX2glTF binary (default: ./FBX2glTF-darwin-x64)
  --framerate <fps>       Animation framerate (default: 30)
  -h, --help              Display help information
  -V, --version           Display version number
```

**Note**: Make sure to specify the correct FBX2glTF binary path for your platform:
- macOS: `--fbx2gltf ./FBX2glTF-darwin-x64`
- Windows: `--fbx2gltf ./FBX2glTF-windows-x64.exe`
- Linux: `--fbx2gltf ./FBX2glTF-linux-x64`

## 🎭 How It Works

1. **FBX Conversion**: Uses FBX2glTF to convert FBX to glTF format
2. **Animation Enhancement**: Analyzes and improves animation timing data
3. **Buffer Embedding**: Embeds binary data to create self-contained files
4. **VRMA Generation**: Converts to VRMA format with proper VRM extensions
5. **Bone Mapping**: Maps Mixamo bones to VRM humanoid specification

## 🔧 Technical Details

### Supported Bone Mapping

The converter automatically maps Mixamo bone names to VRM humanoid bones:

- `mixamorig:Hips` → `hips`
- `mixamorig:Spine` → `spine`
- `mixamorig:Spine1` → `chest`
- `mixamorig:Spine2` → `upperChest`
- `mixamorig:Neck` → `neck`
- `mixamorig:Head` → `head`
- And many more...

### VRMA Format

The generated VRMA files include:
- VRMC_vrm_animation extension v1.0
- Embedded binary buffers
- Proper animation timing metadata
- Humanoid bone mappings

## 🧪 Testing

The converted VRMA files are compatible with:
- [@pixiv/three-vrm-animation](https://github.com/pixiv/three-vrm) v3.4.1+
- Three.js r177+
- Modern web browsers

## 📁 Project Structure

```
fbx2vrma/
├── fbx2vrma-converter.js    # Main converter script
├── README.md                # This file
├── README-jp.md            # Japanese documentation
├── package.json            # Node.js dependencies
├── LICENSE                 # MIT License
└── .gitignore             # Git ignore rules
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [FBX2glTF](https://github.com/facebookincubator/FBX2glTF) - FBX to glTF conversion
- [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) - VRM support for Three.js
- [Mixamo](https://www.mixamo.com/) - Animation source

## 📞 Support

If you encounter any issues or have questions:

1. Check the [Issues](https://github.com/yourusername/fbx2vrma-converter/issues) page
2. Create a new issue with detailed information
3. Include sample files if possible

---

**Mainly created using Claude Code**
