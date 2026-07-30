import React from 'react';
import ReactDOM from 'react-dom';

import App, { AppCallbacks, UiController } from './App';

export default function initialiseControlsUi(
    container: Element,
    callbacks: AppCallbacks
): UiController {
    let mountedController: UiController | null = null;
    const registerController = (controller: UiController) => {
        mountedController = controller;
    };

    ReactDOM.render(<App {...callbacks} registerController={registerController} />, container);

    const withController = (callback: (controller: UiController) => void) => {
        if (mountedController !== null) {
            callback(mountedController);
        }
    };

    return {
        setPlayState: (state, sourceName, message) =>
            withController((controller) => controller.setPlayState(state, sourceName, message)),
        updateSnapshot: (snapshot) =>
            withController((controller) => controller.updateSnapshot(snapshot)),
        updateCursor: (snapshot) =>
            withController((controller) => controller.updateCursor(snapshot)),
        updateTimeOffset: (offset) =>
            withController((controller) => controller.updateTimeOffset(offset)),
        updateZoom: (zoom) => withController((controller) => controller.updateZoom(zoom)),
        updateReturnViewAvailable: (available) =>
            withController((controller) => controller.updateReturnViewAvailable(available)),
        updateMediaLibrary: (items, activeId) =>
            withController((controller) => controller.updateMediaLibrary(items, activeId)),
        updateTransport: (snapshot) =>
            withController((controller) => controller.updateTransport(snapshot)),
        updateSelection: (snapshot) =>
            withController((controller) => controller.updateSelection(snapshot)),
        updateWaveformAxis: (state) =>
            withController((controller) => controller.updateWaveformAxis(state)),
    };
}
