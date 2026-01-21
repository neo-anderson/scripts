# Copilot Instructions

This repository contains a collection of utility scripts for common developer/system tasks.

## Project Structure

- **organize_screenshots.py**: Organizes screenshot files by creation date into folders
- **tarzstd.{py,sh}**: Tar compression utilities with zstd compression (Python and Bash versions)
- **fetch_all_repos.sh**: Batch git fetch for all subdirectories with git repos

## Script Conventions

### Python Scripts
- Target Python 3.x with standard library where possible
- Use `pathlib.Path` for file system operations (see [organize_screenshots.py](organize_screenshots.py#L16))
- Include docstrings for main functions explaining purpose and behavior
- Hardcoded paths should be in `if __name__ == "__main__"` blocks (e.g., [organize_screenshots.py](organize_screenshots.py#L70))
- Use `argparse.ArgumentParser` for CLI arguments with helpful descriptions ([tarzstd.py](tarzstd.py#L14-L21))
- Include usage examples in comments at the top of the file ([tarzstd.py](tarzstd.py#L2-L5))

### Shell Scripts
- Use bash for cross-platform compatibility
- Include comprehensive help messages via `show_help()` functions ([tarzstd.sh](tarzstd.sh#L16-L27))
- Use `getopts` for option parsing with clear option flags
- Support `--help` in addition to `-h` ([tarzstd.sh](tarzstd.sh#L30-L35))
- Include usage examples in comments at the top ([tarzstd.sh](tarzstd.sh#L4-L8))
- Default values should be defined at the top of the script ([tarzstd.sh](tarzstd.sh#L11-L14))

### Parallel Implementations
- Some utilities exist in both Python and shell versions (tarzstd)
- Python versions prioritize readability and simplicity ([tarzstd.py](tarzstd.py))
- Shell versions add advanced features like encryption, verbose mode, and separate archives ([tarzstd.sh](tarzstd.sh#L76-L98))
- Keep option names consistent across implementations (e.g., `-q` for quality level)

## Common Patterns

### File Processing
- Use regex patterns for flexible filename matching: `re.compile(r"^SCR-\d{8}-.*\.png$")` ([organize_screenshots.py](organize_screenshots.py#L18))
- Group files by date using `defaultdict(list)` and `os.path.getctime()` ([organize_screenshots.py](organize_screenshots.py#L36-L42))
- Always wrap file operations in try-except blocks with descriptive error messages

### Git Operations
- Use simple subprocess approach: `(cd "$dir" && git fetch --all)` ([fetch_all_repos.sh](fetch_all_repos.sh#L4))
- Check for `.git` directory before attempting git operations ([fetch_all_repos.sh](fetch_all_repos.sh#L3))

### Compression Workflows
- Pipeline tar with zstd for efficient compression: `tar -cv ... | zstd -${quality} -T0` ([tarzstd.py](tarzstd.py#L32))
- Default quality level is 19 for Python, 14 for shell version
- Use `-T0` flag for multi-threaded zstd compression
- Archive naming: single file uses basename, multiple files use "archive" ([tarzstd.sh](tarzstd.sh#L108-L113))

## Running Scripts

- Python scripts: `python3 organize_screenshots.py` (update hardcoded paths as needed)
- Shell scripts: `chmod +x script.sh && ./script.sh [options] [args]`
- Test directory operations in a safe location before running on production data
