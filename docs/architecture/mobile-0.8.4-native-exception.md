# Mobile 0.8.4 native registration exception

The published mobile 0.8.4 release changed the existing
`apps/mobile/android/app/src/main/java/com/covemobile/CoveNativePackage.kt`.
Commit `9cce11a0983c8ea62a62fef8d3ac5367e77483e9` removed the phone
screen-sharing module import and registration and registered
`CoveSoundpackPlaybackModule` for prepared soundpack playback. The other native
module registrations retained their order. The file is unchanged in published
main commit `5798e0ec0cc802c476505a32ff90c7795604b338`.

The immutable relocation snapshot for that path is
`a6f9d5ce72d85d9a29634b8e374d29fac405fb8fab136d878c238f381a1476d8`.
The previously reviewed integrated-candidate exception led to
`4cd639f4f599d5cf26b8a0c405b4401143d3ceab0a9aaadfa7725ae4248910ce`
at release parent `e31362ce07b316f15265daf6796730d947390b76`; the 0.8.4
release changed it to
`bb42db264a136dc3e27e71ede40b75196f364010a3dbefd5eb2175cf45504e8f`.
These are SHA-256 hashes of UTF-8 source after CRLF-to-LF normalization.

The architecture gate accepts only this exact path and transition after
checking the original snapshot and earlier exception. This record describes an
already published APK and does not authorize another mobile release.
