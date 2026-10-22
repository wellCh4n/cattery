#!/bin/sh
set -eu

# A newly mounted workspace hides the image's home files. Seed only missing
# shell defaults, keeping the project's own configuration across restarts.
for file in .bashrc .profile .bash_logout; do
    if [ ! -e "$HOME/$file" ] && [ ! -L "$HOME/$file" ]; then
        cp "/etc/skel/$file" "$HOME/$file"
    fi
done

cd "${WORK_DIR:-$HOME}"
exec "$@"
