#!/bin/bash

# tar and compress using zstd with 19 as default quality
# Example usage:
#   ./tarzstd.sh -q 3 file1 file2 folder1
#   ./tarzstd.sh file1
#   ./tarzstd.sh *     # archive files and folders excluding hidden ones
#   ./tarzstd.sh .* * # archive all files and folders including hidden ones
#   ./tarzstd.sh {.,}* # same as above, but using fish wildcard globbing

# Defaults
quality=14
encrypt=false
verbose=false
separate=false

show_help() {
    cat << EOF
Usage: $(basename "$0") [-q compression_level] [-e] [-v] [-s] [-h|--help] file_or_folder [more_files_and_folders...]

Tar and compress files/folders using zstd.

Options:
  -q level      Set the zstd compression level (1-19). Default: ${quality}.
  -e            Encrypt the archive using gpg. Default: ${encrypt}.
  -v            Enable verbose output from tar. Default: ${verbose}.
  -s            Create a separate archive for each input. Default: ${separate}.
  -h, --help    Display this help message and exit.
EOF
}

# Handle --help argument before getopts
for arg in "$@"; do
  if [ "$arg" == "--help" ]; then
    show_help
    exit 0
  fi
done


error_msg="Usage: $(basename "$0") [-q compression_level] [-e] [-v] [-s] file_or_folder [...]. See --help for more info."

# Parse command-line options for quality and encryption
# Finally, clean up the argument list so only the non-option arguments (files/folders) remain.
while getopts "q:evsh" opt; do
    case "$opt" in
        q)
            quality="$OPTARG"
            ;;
        e)
            encrypt=true
            ;;
        v)
            verbose=true
            ;;
        s)
            separate=true
            ;;
        h)
            show_help
            exit 0
            ;;
        *)
            echo "$error_msg"
            exit 1
    esac
done
shift $(( OPTIND - 1 ))

# Ensure at least one input is provided
if [ "$#" -eq 0 ]; then
    echo "$error_msg"
    exit 1
fi

# Set tar options based on verbosity
tar_opts="c"
if [ "$verbose" = true ]; then
    tar_opts="${tar_opts}v"
fi


# Function to create a single archive
create_archive() {
    local out_name="$1"
    shift
    local inputs=("$@")

    if [ "$encrypt" = true ]; then
        # Compress and encrypt in a single pipeline
        local final_archive="${out_name}.tar.zst.gpg"
        echo "Creating encrypted archive: $final_archive"
        tar -${tar_opts} "${inputs[@]}" | zstd -${quality} -T0 | gpg -o "$final_archive" --compress-algo none --no-armor -e
    else
        # Standard compression without encryption
        local archive_name="${out_name}.tar.zst"
        echo "Creating archive: $archive_name"
        tar -${tar_opts} "${inputs[@]}" | zstd -${quality} -T0 > "$archive_name"
    fi
}

if [ "$separate" = true ]; then
    # Loop through each file/folder and create a separate archive for each
    for item in "$@"; do
        create_archive "$(basename "$item")" "$item"
    done
else
    # Determine output name for single archive:
    # if one input, use its basename; otherwise, use 'archive'
    if [ "$#" -eq 1 ]; then
        out_name=$(basename "$1")
    else
        out_name="archive"
    fi
    create_archive "$out_name" "$@"
fi

# # Determine output name: if one input, use its basename; otherwise, use 'archive'
# if [ "$#" -eq 1 ]; then
#     out_name=$(basename "$1")
# else
#     out_name="archive"
# fi

# if [ "$encrypt" = true ]; then
#     # Compress and encrypt in a single pipeline
#     final_archive="${out_name}.tar.zst.gpg"
#     tar -${tar_opts} "$@" | zstd -${quality} -T0 | gpg -o "$final_archive" --compress-algo none --no-armor -e
#     echo "Created encrypted archive: $final_archive"
# else
#     # Standard compression without encryption
#     archive_name="${out_name}.tar.zst"
#     tar -${tar_opts} "$@" | zstd -${quality} -T0 > "$archive_name"
#     echo "Created archive: $archive_name"
# fi