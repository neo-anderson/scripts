#!/bin/bash

# tar and compress using zstd with 19 as default quality

# Default compression quality
quality=19
error_msg="Usage: tarzstd [-q compression_level] file_or_folder [more_files_and_folders...]"

# Parse command-line option for quality and store it
# Finally, clean up the argument list so only the non-option arguments (files/folders) remain.
while getopts "q:" opt; do
    case "$opt" in
        q)
            quality="$OPTARG"
            ;;
        *)
            echo "$error_msg"
            exit 1
            ;;
    esac
done
shift $(( OPTIND - 1 ))

# Ensure at least one input is provided
if [ "$#" -eq 0 ]; then
    echo "$error_msg"
    exit 1
fi

# Determine output name: if one input, use its basename; otherwise, use 'archive'
if [ "$#" -eq 1 ]; then
    out_name=$(basename "$1")
else
    out_name="archive"
fi
archive_name="${out_name}.tar.zst"

tar -cv "$@" | zstd -${quality} -T0 > "$archive_name"
echo "Created archive: $archive_name"
