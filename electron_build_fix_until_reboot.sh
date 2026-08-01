echo "This is from the desktop thing. run if it doesn't let you exist";
# Enable unprivileged user namespaces.
sudo sysctl -w kernel.unprivileged_userns_clone=1;

# Stop AppArmor from preventing unprivileged user namespace creation by default.
# If your distribution does not use AppArmor then you can ignore the error.
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0;
