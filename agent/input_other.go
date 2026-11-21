//go:build !windows

package main

import "errors"

var errUnsupportedPlatform = errors.New("input injection is only implemented for Windows in this build")

func screenSize() (int, int)                                      { return 0, 0 }
func pointerSupported() bool                                      { return false }
func movePointer(nx, ny float64) error                            { return errUnsupportedPlatform }
func pressPointer(nx, ny float64, button string, down bool) error { return errUnsupportedPlatform }
func scrollPointer(delta int32, horizontal bool) error            { return errUnsupportedPlatform }
func pressKey(vk int, down bool) error                            { return errUnsupportedPlatform }
