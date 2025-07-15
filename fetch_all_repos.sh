#!/bin/bash
for dir in */; do
  if [ -d "$dir/.git" ]; then
    echo "Fetching in $dir"
    (cd "$dir" && git fetch --all)
  fi
done
